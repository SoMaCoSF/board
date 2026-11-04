import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { vercelProject, oidcTokens, type CallerRequest, type Can, type HostPrincipal, type RuleFunction } from '../src/access/index.ts'
// The engine itself, as a2() starts it: these tests are about what it does.
import { mount as board, type MountOptions } from './harness.ts'
import { vercelBlob } from '../src/blob/vercel.ts'
import { fakeQueue } from './queue.ts'
import { BOARD_URL, caller, deploymentToken, PROJECT_ID, personToken, TEAM_ID, testAuth, testBoard } from './harness.ts'

/** A host's credentials: opaque platform tokens it verifies itself, each naming a team. */
const PLATFORM: Record<string, { team: string; principal: HostPrincipal }> = {
  pt_ada: { team: 'team_a', principal: { id: 'vercel:user:u_ada', kind: 'person', handle: 'user-ada' } },
  pt_viewer: { team: 'team_a', principal: { id: 'vercel:user:u_view', kind: 'person', handle: 'user-view' } },
  pt_bob: { team: 'team_b', principal: { id: 'vercel:user:u_bob', kind: 'person', handle: 'user-bob' } },
  pt_deploy: { team: 'team_a', principal: { id: 'vercel:project:prj_app:production', kind: 'deployment', handle: 'app' } },
}

/** The host's own model: what each principal may do. */
const GRANTS: Record<string, Can> = {
  'vercel:user:u_ada': 'all',
  'vercel:user:u_view': ['read'],
  'vercel:user:u_bob': 'all',
  'vercel:project:prj_app:production': { 'feedback/': ['post'] },
}

/** Who a request is, as a host's own credentials say: only on its own team's board. */
const authenticate = (team: string) => (request: CallerRequest) => {
  const token = request.credential ?? ''
  const found = PLATFORM[token]
  if (!found || found.team !== team) return Response.json({ error: { code: 'not_found', message: 'no board here' } }, { status: 404 })
  return found.principal
}

/** One board per team, like a host would build them, each answering only for its own team. */
function hosted(team: string, options: Partial<MountOptions> = {}) {
  return board({
    store: memory(),
    url: BOARD_URL,
    // The host's own project: its tokens must get nothing unless `authenticate` names them.
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    authenticate: authenticate(team),
    access: (principal) => GRANTS[principal.id] ?? null,
    ...options,
  })
}

describe("a host's authenticate and access", () => {
  it("trusts nothing built in: the host project's own person and deployment tokens get no access", async () => {
    const tenant = hosted('team_a')
    for (const token of [await personToken(), await deploymentToken('board', PROJECT_ID)]) {
      const call = caller(tenant.fetch, token)
      expect((await call('GET', '/messages')).status).toBe(404)
      expect((await call('POST', '/messages', { channel: 'dev', text: 'hi' })).status).toBe(404)
    }
  })

  it("accepts what it grants, with no audience check, and keeps its handle over the one the CLI sends", async () => {
    const ada = caller(hosted('team_a').fetch, 'pt_ada', { 'x-board-handle': 'bob', 'x-board-profile': 'pi' })
    const me = await ada('GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ principal: 'vercel:user:u_ada', actor: 'vercel:user:u_ada+pi', handle: 'user-ada/pi', expiresAt: null })
  })

  it("takes the CLI's handle when its verifier returns it", async () => {
    const tenant = hosted('team_a', {
      authenticate: (request) => {
        const found = authenticate('team_a')(request)
        return found instanceof Response ? found : { ...found, handle: request.claims.handle ?? found.handle }
      },
    })
    const ada = caller(tenant.fetch, 'pt_ada', { 'x-board-handle': 'ada' })
    expect((await ada('GET', '/me')).body).toMatchObject({ principal: 'vercel:user:u_ada', handle: 'ada' })
  })

  it('carries its principal through reads, writes, tails and SSE', async () => {
    const tenant = hosted('team_a')
    const ada = caller(tenant.fetch, 'pt_ada', { 'x-board-handle': 'ada' })
    const posted = await ada('POST', '/messages', { channel: 'dev', text: 'one' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by.principal).toBe('vercel:user:u_ada')
    expect((await ada('POST', `/messages/${posted.body.message.id}/labels`, { set: { kind: 'bug' } })).status).toBe(200)

    expect((await ada('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)).toEqual(['one'])
    expect((await ada('GET', `/messages/${posted.body.message.id}`)).body.message.labels).toEqual({ kind: 'bug' })
    const tail = await ada('GET', '/events?after=0&channel=dev')
    expect(tail.body.events.map((e: { type: string }) => e.type)).toContain('message.posted')

    const controller = new AbortController()
    const response = await tenant.fetch(
      new Request(`${BOARD_URL}/events?after=0`, {
        headers: { authorization: 'Bearer pt_ada', accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    )
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('"text":"one"')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(text).toContain('"text":"one"')
    controller.abort()
  })

  it('gives what its access function grants, per channel: a viewer reads but cannot write', async () => {
    const tenant = hosted('team_a')
    await caller(tenant.fetch, 'pt_ada')('POST', '/messages', { channel: 'dev', text: 'one' })
    const viewer = caller(tenant.fetch, 'pt_viewer')
    expect((await viewer('GET', '/messages')).body.messages).toHaveLength(1)
    expect((await viewer('POST', '/messages', { channel: 'dev', text: 'two' })).status).toBe(403)

    // Write-only, in one subtree: it posts feedback and reads nothing.
    const deploy = caller(tenant.fetch, 'pt_deploy')
    expect((await deploy('POST', '/messages', { channel: 'feedback/app', text: 'from the app' })).status).toBe(201)
    expect((await deploy('POST', '/messages', { channel: 'dev', text: 'elsewhere' })).status).toBe(403)
    expect((await deploy('GET', '/messages')).body.messages).toEqual([])
  })

  it("keeps two tenants' boards apart", async () => {
    const a = hosted('team_a')
    const b = hosted('team_b')
    await caller(a.fetch, 'pt_ada')('POST', '/messages', { channel: 'dev', text: 'team a only' })
    const bob = caller(b.fetch, 'pt_bob')
    expect((await bob('GET', '/messages')).body.messages).toEqual([])
    // Ada's credentials don't open team b's board.
    expect((await caller(b.fetch, 'pt_ada')('GET', '/messages')).status).toBe(404)
  })

  it('rejects with the Response it throws, and fails on a principal that breaks the ID scheme', async () => {
    const thrown = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => {
        throw new Response('{"error":"nope"}', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
      },
    })
    const rejected = await thrown.fetch(new Request(`${BOARD_URL}/messages`))
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get('www-authenticate')).toBe('Bearer')

    const malformed = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => ({ id: 'ada+pi', kind: 'person', handle: 'ada' }),
    })
    expect((await caller(malformed.fetch, 'x')('GET', '/messages')).status).toBe(500)
    // `]` would end an exact mention, `@[<actor id>]`, so nobody could mention it.
    const unmentionable = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => ({ id: 'vercel:user:a]b', kind: 'person', handle: 'ada' }),
    })
    expect((await caller(unmentionable.fetch, 'x')('GET', '/messages')).status).toBe(500)

    const expired = board({
      store: memory(),
      url: BOARD_URL,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada', expiresAt: new Date(0) }),
    })
    expect((await caller(expired.fetch, 'x')('GET', '/messages')).status).toBe(401)
  })

  it("recognizes a page's own session from its headers, with no token", async () => {
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      // A same-site page's `fetch` sends its cookie: the host knows whose session it is.
      authenticate: (request) =>
        request.headers.get('cookie') === 'session=ada'
          ? { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }
          : Response.json({ error: { code: 'unauthorized', message: 'sign in' } }, { status: 401 }),
      access: () => 'all',
    })
    const page = (cookie: string) => tenant.fetch(new Request(`${BOARD_URL}/me`, { headers: { cookie, 'x-board-profile': 'page' } }))
    expect(await (await page('session=ada')).json()).toMatchObject({ actor: 'vercel:user:u_ada+page', principal: 'vercel:user:u_ada' })
    expect((await page('session=eve')).status).toBe(401)
  })

  it("gives a host's principals what their kind gets under the rules", async () => {
    const rules = board({ store: memory(), url: BOARD_URL, authenticate: authenticate('team_a') })
    // A person the host vouches for is a person: everything, as the board's own people.
    expect((await caller(rules.fetch, 'pt_ada')('GET', '/me')).body.can).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] })
    // A deployment it names gets what a rule gives its ID: none here.
    expect((await caller(rules.fetch, 'pt_deploy')('GET', '/me')).body.error.message).toBe("this token can't use this board: add vercelProject({ project: 'prj_app', can }) to access")
  })

  it("composes with vb's tokens: a session cookie, or a bearer token, and nothing is a 401", async () => {
    const tokens = oidcTokens(testAuth)
    // The host's session: null when the request carries none, so the next verifier gets it.
    const staff = (request: CallerRequest) =>
      request.headers.get('cookie') === 'session=ada' ? ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' } as const) : null
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      project: { id: PROJECT_ID, teamId: TEAM_ID },
      authenticate: async (request) => (await staff(request)) ?? (await tokens(request)),
    })
    const me = async (headers: Record<string, string>) => {
      const response = await tenant.fetch(new Request(`${BOARD_URL}/me`, { headers }))
      return { status: response.status, body: await response.json() }
    }
    expect(await me({ cookie: 'session=ada' })).toMatchObject({ status: 200, body: { principal: 'vercel:user:u_ada' } })
    expect(await me({ authorization: `Bearer ${await personToken()}` })).toMatchObject({ status: 200, body: { principal: 'vercel:user:u_julian' } })
    // A token that fails is refused, not passed over.
    expect(await me({ authorization: `Bearer ${await personToken('u_julian', 'https://elsewhere.test/api/board')}` })).toMatchObject({ status: 401 })
    expect(await me({})).toMatchObject({ status: 401, body: { error: { code: 'unauthorized', message: 'missing bearer token' } } })
  })
})

/** An app's own site: its session cookie names staff (people) and customers (external), and `vb`'s tokens still work. */
function supportBoard(rules: (customers: RuleFunction) => MountOptions['access'], customers: RuleFunction) {
  const tokens = oidcTokens(testAuth)
  const session = (request: CallerRequest): HostPrincipal | null => {
    const cookie = request.headers.get('cookie') ?? ''
    if (cookie === 'session=staff-ada') return { id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }
    const customer = /^session=customer-(\d+)$/.exec(cookie)?.[1]
    return customer ? { id: `support:customer:${customer}`, kind: 'external', handle: `customer-${customer}` } : null
  }
  return board({
    store: memory(),
    url: BOARD_URL,
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    authenticate: async (request) => session(request) ?? (await tokens(request)),
    access: rules(customers),
  })
}

const asCookie = (tenant: { fetch(request: Request): Promise<Response> }, cookie: string) => async (method: string, path: string, body?: unknown) => {
  const response = await tenant.fetch(
    new Request(`${BOARD_URL}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  )
  return { status: response.status, body: await response.json() }
}

describe('a function among the access rules', () => {
  const customers: RuleFunction = (principal) => (principal.id.startsWith('support:customer:') ? { 'support/': ['read', 'post'] } : undefined)

  it("gives a host's external principal what it returns, and nothing past it", async () => {
    const tenant = supportBoard((fn) => [vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }), fn], customers)
    const customer = asCookie(tenant, 'session=customer-99')
    expect((await customer('GET', '/me')).body).toMatchObject({ principal: 'support:customer:99', can: { 'support/': ['read', 'post'] } })
    expect((await customer('POST', '/messages', { channel: 'support/billing', text: 'my invoice is wrong' })).status).toBe(201)
    expect((await customer('POST', '/messages', { channel: 'dev', text: 'hello?' })).status).toBe(403)
    // The token rules still decide for tokens.
    expect((await caller(tenant.fetch, await deploymentToken('front', 'prj_front'))('GET', '/me')).body.can).toEqual({ 'feedback/': ['post'] })
    // Without it, the rules give the customer nothing: `external` gets everything only as a platform user sync writes as.
    const without = supportBoard(() => [vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } })], customers)
    expect((await asCookie(without, 'session=customer-99')('GET', '/me')).body).toMatchObject({ error: { code: 'forbidden', message: "this token can't use this board" } })
  })

  it("keeps a sync from writing as a host's principal, or as the watchers it registered, whatever platform it names", async () => {
    const tenant = supportBoard((fn) => [vercelProject({ project: 'prj_sync', can: 'all' }), fn], customers)
    const customer = asCookie(tenant, 'session=customer-99')
    const staff = asCookie(tenant, 'session=staff-ada')
    expect((await customer('POST', '/watchers', { watch: { inbox: { tail: 'support/' } } })).status).toBe(200)
    expect((await customer('POST', '/messages', { channel: 'support/billing', text: 'my invoice is wrong' })).status).toBe(201)
    expect((await staff('POST', '/messages', { channel: 'support/billing', text: 'on it' })).status).toBe(201)
    // A sync that says its platform is `support`, or `vercel`'s like, speaks for neither.
    const sync = caller(tenant.fetch, await deploymentToken('sync', 'prj_sync'))
    expect((await sync('POST', '/watchers', { watch: {}, sync: [{ key: 'support', platform: 'support' }] })).status).toBe(200)
    const as = (id: string) => sync('POST', '/sync/imports', { op: 'post', author: { id, handle: 'x', name: 'X', avatar: null, isBot: false }, from: 'support', channel: 'support/billing', text: `as ${id}` })
    // Its watcher's own writes don't wake it, so an import as it would hide what it says from it.
    for (const id of ['support:customer:99+inbox', 'support:customer:99']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error?.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
    }
    expect((await as('support:user:7')).status).toBe(200)
  })

  it("keeps a sync from writing as a host's principal that wrote, or its profiles, though it registered nothing", async () => {
    const tenant = supportBoard((fn) => [vercelProject({ project: 'prj_sync', can: 'all' }), fn], customers)
    // Two of the host's external principals write, one as a profile of its own, and neither registers anything.
    const write = (cookie: string, headers: Record<string, string> = {}) =>
      tenant.fetch(new Request(`${BOARD_URL}/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ channel: 'support/billing', text: 'refund please' }) }))
    expect((await write('session=customer-42')).status).toBe(201)
    expect((await write('session=customer-43', { 'x-board-profile': 'helper' })).status).toBe(201)
    const sync = caller(tenant.fetch, await deploymentToken('sync', 'prj_sync'))
    expect((await sync('POST', '/watchers', { watch: {}, sync: [{ key: 'support', platform: 'support' }] })).status).toBe(200)
    const as = (id: string) => sync('POST', '/sync/imports', { op: 'post', author: { id, handle: 'x', name: 'X', avatar: null, isBot: false }, from: 'support', channel: 'support/billing', text: `as ${id}` })
    for (const id of ['support:customer:42', 'support:customer:43+helper']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error?.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
    }
    // One the board has never seen is what the access page says to keep out of a sync's reach: an ID scheme no sync registers.
    expect((await as('support:customer:44')).status).toBe(200)
  })

  it('leaves a principal to the next rule when it returns undefined', async () => {
    const asked: string[] = []
    const passes: RuleFunction = (principal) => void asked.push(principal.id)
    const tenant = supportBoard((fn) => [passes, vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }), fn], customers)
    expect((await caller(tenant.fetch, await deploymentToken('front', 'prj_front'))('GET', '/me')).body.can).toEqual({ 'feedback/': ['post'] })
    expect((await asCookie(tenant, 'session=customer-7')('GET', '/me')).body.can).toEqual({ 'support/': ['read', 'post'] })
    expect(asked).toEqual(['vercel:project:prj_front:production', 'support:customer:7'])
    // Past the last rule, a token still hears which rule would let it in.
    expect((await caller(tenant.fetch, await deploymentToken())('GET', '/me')).body.error.message).toBe(
      "this token can't use this board: add vercelProject({ project: 'marketing', can }) to access",
    )
  })

  it('stops at null: the rules after it are never asked', async () => {
    const tenant = supportBoard((fn) => [() => null, vercelProject({ project: 'prj_front', can: 'all' }), fn], customers)
    for (const call of [caller(tenant.fetch, await deploymentToken('front', 'prj_front')), asCookie(tenant, 'session=customer-99')])
      expect((await call('GET', '/me')).body).toMatchObject({ error: { code: 'forbidden', message: "this token can't use this board" } })
  })

  it("can't take the defaults away: a person, and the board's own deployments where it runs, still get everything", async () => {
    vi.stubEnv('VERCEL_TARGET_ENV', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    try {
      const asked: string[] = []
      const tenant = supportBoard(() => [(principal) => (asked.push(principal.id), null)], customers)
      const everything = { '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] }
      expect((await asCookie(tenant, 'session=staff-ada')('GET', '/me')).body).toMatchObject({ principal: 'vercel:user:u_ada', can: everything })
      expect((await caller(tenant.fetch, await personToken())('GET', '/me')).body.can).toEqual(everything)
      expect((await caller(tenant.fetch, await deploymentToken('board', PROJECT_ID))('GET', '/me')).body.can).toEqual(everything)
      expect(asked).toEqual([])
      // Its previews aren't a default: the function decides for them.
      expect((await caller(tenant.fetch, await deploymentToken('board', PROJECT_ID, 'preview'))('GET', '/me')).status).toBe(403)
      expect(asked).toEqual([`vercel:project:${PROJECT_ID}:preview`])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("a function rule's schedules", () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  const HOUR = 3_600_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('ask it again at each send, and are revoked once it gives nothing', async () => {
    const queue = fakeQueue()
    const open = { support: true }
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: (request) => (request.headers.get('cookie') === 'session=customer-99' ? { id: 'support:customer:99', kind: 'external', handle: 'customer-99' } : null),
      access: [(principal) => (principal.id === 'support:customer:99' ? (open.support ? { 'support/': ['read', 'post'] } : null) : undefined)],
    })
    const customer = asCookie(tenant, 'session=customer-99')
    const advance = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      vi.setSystemTime(Date.now() + ms)
      await queue.fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const created = await customer('POST', '/schedules', { channel: 'support', text: 'still waiting', every: '1h' })
    expect(created.status).toBe(201)
    await advance(HOUR)
    expect((await customer('GET', '/messages?channel=support')).body.messages).toMatchObject([{ text: 'still waiting' }])
    // The app closes the customer's support access: the next send asks, and gets nothing.
    open.support = false
    await advance(HOUR)
    open.support = true
    expect((await customer('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ id: created.body.schedule.id, sent: 1, state: 'canceled', canceled: { reason: 'revoked' } }])
    expect((await customer('GET', '/messages?channel=support')).body.messages).toHaveLength(1)
  })
})

const blobs = vi.hoisted(() => new Map<string, { data: Uint8Array; contentType: string }>())
vi.mock('@vercel/blob', () => ({
  put: async (key: string, data: Buffer, options: { contentType: string }) => void blobs.set(key, { data: new Uint8Array(data), contentType: options.contentType }),
  get: async (key: string) => {
    const found = blobs.get(key)
    return found ? { statusCode: 200, stream: found.data, blob: { contentType: found.contentType } } : null
  },
}))

describe('two hosted boards on one Vercel Blob store', () => {
  it("don't serve each other's attachments when each has its own prefix", async () => {
    const a = hosted('team_a', { blob: vercelBlob({ prefix: 'team_a' }) })
    const b = hosted('team_b', { blob: vercelBlob({ prefix: 'team_b' }) })
    const upload = await a.fetch(
      new Request(`${BOARD_URL}/attachments`, {
        method: 'POST',
        headers: { authorization: 'Bearer pt_ada', 'content-type': 'text/plain', 'x-board-filename': 'secret.txt' },
        body: 'team a only',
      }),
    )
    const { attachment } = await upload.json()
    expect([...blobs.keys()].every((key) => key.startsWith('team_a/board/attachments/'))).toBe(true)

    const read = (tenant: typeof a, token: string) =>
      tenant.fetch(new Request(`${BOARD_URL}/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${token}` } }))
    expect(await (await read(a, 'pt_ada')).text()).toBe('team a only')
    expect((await read(b, 'pt_bob')).status).toBe(404)
  })
})

describe("schedules from a host's principal", () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  const HOUR = 3_600_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  /** A person the host grants dev/ until `grant.until`: there's no request to ask again when a schedule sends. */
  async function setup(until: number) {
    const grant = { until }
    const queue = fakeQueue()
    const tenant = board({
      store: memory(),
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada', expiresAt: new Date(grant.until) }),
      access: () => ({ 'dev/': ['read', 'post'] }),
    })
    const ada = caller(tenant.fetch, 'pt_ada')
    const advance = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      vi.setSystemTime(Date.now() + ms)
      await queue.fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return { ada, advance, grant }
  }

  it('send with the access granted when they were made', async () => {
    const { ada, advance } = await setup(T0 + 24 * HOUR)
    expect((await ada('POST', '/schedules', { channel: 'ops', text: 'not mine', in: '1h' })).status).toBe(403)
    const { body } = await ada('POST', '/schedules', { channel: 'dev/standup', text: 'standup', in: '1h' })
    await advance(HOUR)
    expect((await ada('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ id: body.schedule.id, state: 'done', sent: 1 }])
    expect((await ada('GET', '/messages?channel=dev/standup')).body.messages).toMatchObject([{ text: 'standup' }])
  })

  it('are revoked once that grant has expired, even for a person', async () => {
    const { ada, advance, grant } = await setup(T0 + 2 * HOUR)
    await ada('POST', '/schedules', { channel: 'dev/standup', text: 'standup', in: '3h' })
    await advance(3 * HOUR)
    // The host signs Ada in again, so she can see what happened.
    grant.until = Date.now() + HOUR
    expect((await ada('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'canceled', sent: 0, canceled: { reason: 'revoked' } }])
    expect((await ada('GET', '/messages?channel=dev/standup')).body.messages).toEqual([])
  })
})

describe("a board that switches to a host's model", () => {
  const T0 = Date.parse('2026-10-07T12:00:00.000Z')
  const HOUR = 3_600_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it("asks its function about schedules the built-in verifier's callers made, instead of trusting them", async () => {
    const store = memory()
    const queue = fakeQueue()
    const before = testBoard({ store, scheduler: queue.scheduler })
    const julian = caller(before.fetch, await personToken())
    expect((await julian('POST', '/schedules', { channel: 'dev', text: 'from before', in: '1h' })).status).toBe(201)

    // The same log, now behind a host that only knows Ada: its function decides for everyone.
    const after = board({
      store,
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }),
      access: (principal) => (principal.id === 'vercel:user:u_ada' ? 'all' : null),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const ada = caller(after.fetch, 'pt_ada')
    expect((await ada('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'canceled', sent: 0, canceled: { reason: 'revoked' } }])
    expect((await ada('GET', '/messages?channel=dev')).body.messages).toEqual([])
  })

  it("revokes a host's principals' schedules once the board drops its function", async () => {
    const store = memory()
    const queue = fakeQueue()
    const before = board({
      store,
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }),
      access: () => 'all',
    })
    expect((await caller(before.fetch, 'pt_ada')('POST', '/schedules', { channel: 'dev', text: 'from the host', in: '1h' })).status).toBe(201)

    const after = testBoard({ store, scheduler: queue.scheduler })
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const julian = caller(after.fetch, await personToken())
    expect((await julian('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ state: 'canceled', canceled: { reason: 'revoked' } }])
    expect((await julian('GET', '/messages?channel=dev')).body.messages).toEqual([])
  })

  it("keeps sending the board's own code's schedules under a function", async () => {
    const queue = fakeQueue()
    const hostedBoard = board({
      store: memory(),
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }),
      access: () => 'all',
    })
    await hostedBoard.as('digest').schedule('dev', { text: 'daily digest', in: '1h' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.setSystemTime(T0 + HOUR)
    await queue.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await caller(hostedBoard.fetch, 'pt_ada')('GET', '/messages?channel=dev')).body.messages).toMatchObject([{ text: 'daily digest' }])
  })
})
