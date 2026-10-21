import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import type { Can, HostPrincipal } from '../src/access/index.ts'
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
const authenticate = (team: string) => (request: Request) => {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
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

  it('accepts what it grants, with no audience check, and the CLI still sends the handle', async () => {
    const ada = caller(hosted('team_a').fetch, 'pt_ada', { 'x-board-handle': 'ada', 'x-board-profile': 'pi' })
    const me = await ada('GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ principal: 'vercel:user:u_ada', actor: 'vercel:user:u_ada+pi', handle: 'ada/pi', expiresAt: null })
  })

  it('carries its principal through reads, writes, /identity, tails and SSE', async () => {
    const tenant = hosted('team_a')
    const ada = caller(tenant.fetch, 'pt_ada', { 'x-board-handle': 'ada' })
    const posted = await ada('POST', '/messages', { channel: 'dev', text: 'one' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by.principal).toBe('vercel:user:u_ada')
    expect((await ada('POST', `/messages/${posted.body.message.id}/labels`, { set: { kind: 'bug' } })).status).toBe(200)

    expect((await ada('GET', '/messages?channel=dev')).body.messages.map((m: { text: string }) => m.text)).toEqual(['one'])
    expect((await ada('GET', `/messages/${posted.body.message.id}`)).body.message.labels).toEqual({ kind: 'bug' })
    expect((await ada('GET', '/identity')).body).toMatchObject({ principal: 'vercel:user:u_ada', links: [] })
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

  it("can't be combined with the test issuers it replaces", () => {
    const authenticate = () => new Response(null, { status: 401 })
    expect(() => board({ store: memory(), authenticate, auth: testAuth })).toThrow(/authenticate replaces/)
  })

  it("gives a host's principal nothing without an access function, and the built-in callers nothing with one", async () => {
    const rules = board({ store: memory(), url: BOARD_URL, authenticate: authenticate('team_a') })
    expect((await caller(rules.fetch, 'pt_ada')('GET', '/me')).status).toBe(403)
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
    expect([...blobs.keys()].every((key) => key.startsWith('team_a/vboard/attachments/'))).toBe(true)

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

  it("revokes schedules the built-in verifier's callers made, instead of trusting them", async () => {
    const store = memory()
    const queue = fakeQueue()
    const before = testBoard({ store, scheduler: queue.scheduler })
    const julian = caller(before.fetch, await personToken())
    expect((await julian('POST', '/schedules', { channel: 'dev', text: 'from before', in: '1h' })).status).toBe(201)

    // The same log, now behind a host that only knows Ada.
    const after = board({
      store,
      url: BOARD_URL,
      scheduler: queue.scheduler,
      authenticate: () => ({ id: 'vercel:user:u_ada', kind: 'person', handle: 'ada' }),
      access: () => 'all',
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
