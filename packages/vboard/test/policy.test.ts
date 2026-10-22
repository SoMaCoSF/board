import { afterEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { board, type Middleware, type MiddlewareContext, type Watcher, type WatcherContext } from '../src/server/index.ts'
import { oidcTokens, vercelProject, type Can, type HostPrincipal } from '../src/access/index.ts'
import { a2 } from '../src/backend-a2/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, TEAM_ID, testAuth, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

// Who may use a board, and what its writes go through, are board()'s, on any backend: it
// verifies each caller, applies `access`, and runs the middleware, then calls the backend.

/** Where the support app's board is mounted: a board on the team's board, over http(). */
const SUPPORT_URL = 'https://support.test/api/board'
const SUPPORT = 'vercel:project:prj_support:production'
const supportToken = () => deploymentToken('support', 'prj_support', 'production')
const MARKETING = 'vercel:project:prj_marketing:production'

/** The team's board, and a request to it or to the support app's board, as each URL says. */
function team(remote: ReturnType<typeof testBoard>, project: () => { fetch(request: Request): Promise<Response> }) {
  const seen: Request[] = []
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) {
      seen.push(request.clone())
      return remote.fetch(request)
    }
    if (request.url.startsWith(SUPPORT_URL)) return project().fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  return { seen, fetch: bearer(route, supportToken) }
}

/** A request to `fetch` at `url`, as a browser with `cookie` sends it. */
const withCookie = (fetch: (request: Request) => Promise<Response>, cookie: string | null, url = SUPPORT_URL) => async (method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }
  const response = await fetch(new Request(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>) => caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

afterEach(() => vi.useRealTimers())

describe('a board on http() with no access of its own', () => {
  it('serves no request but wake-ups and webhooks: it verifies none, and nothing reaches the board it uses', async () => {
    const remote = testBoard({ access: [vercelProject({ project: 'prj_support', can: 'all' })] })
    let project: ReturnType<typeof board>
    const { seen, fetch } = team(remote, () => project)
    const authenticate = vi.fn(async (): Promise<HostPrincipal> => ({ id: 'app:user:ada', kind: 'person', handle: 'ada' }))
    // An `authenticate` alone opens nothing: without `access`, the board it uses keeps the say.
    project = board({ backend: http(BOARD_URL, { fetch }), url: SUPPORT_URL, authenticate })
    const ada = withCookie(project.fetch, 'session=ada')
    const nothing = { error: { code: 'not_found', message: `${SUPPORT_URL} answers only wake-ups and webhooks` } }
    for (const [method, path, body] of [
      ['GET', '/', undefined],
      ['GET', '/me', undefined],
      ['GET', '/messages', undefined],
      ['POST', '/messages', { channel: 'support', text: 'hi' }],
      ['POST', '/schedules', { channel: 'support', text: 'hi', in: '1h' }],
      ['POST', '/messages/1/sync', { target: 'slack:#general' }],
    ] as const)
      expect(await ada(method, path, body), `${method} ${path}`).toEqual({ status: 404, body: nothing })
    expect(authenticate).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    // Its own code still reaches the board it uses, as the project.
    expect((await project.post('support', 'from the app')).by.principal).toBe(SUPPORT)
  })
})

describe('a board on http() with an access of its own', () => {
  /**
   * The support app's board, a gateway for its own users on the team's board: it recognizes their
   * session cookie and gives each what `can` says. The team's board lets the project read and post
   * in support/ and read dev.
   */
  function gateway(can: Record<string, Can>, watch: Record<string, Watcher> = {}) {
    const remote = testBoard({ access: [vercelProject({ project: 'prj_support', can: { 'support/': ['read', 'post'], dev: ['read'] } })] })
    let project: ReturnType<typeof board>
    const { seen, fetch } = team(remote, () => project)
    const users: Record<string, HostPrincipal> = {
      'session=ada': { id: 'app:user:ada', kind: 'person', handle: 'ada.lovelace' },
      'session=root': { id: 'app:user:root', kind: 'person', handle: 'julian' },
      'session=fix': { id: 'app:user:fix', kind: 'person', handle: 'Fix' },
    }
    const backend = http(BOARD_URL, { fetch })
    project = board({
      backend,
      url: SUPPORT_URL,
      authenticate: (request) => users[request.headers.get('cookie') ?? ''] ?? null,
      access: (principal) => can[principal.id] ?? null,
      watch,
    })
    return { remote, project, backend, seen, as: (cookie: string | null) => withCookie(project.fetch, cookie) }
  }

  it("never labels a caller with its own watchers' profiles, so a caller's write still wakes them", async () => {
    const fix: Watcher = { tail: 'support/', run: () => {} }
    const { remote, backend, as } = gateway({ 'app:user:fix': { 'support/': ['read', 'post'] } }, { fix })
    await backend.registerWatchers()
    // A caller whose handle is the watcher's ID: on the team's board, the watcher's writes are by `<project>+fix`.
    const posted = await as('session=fix')('POST', '/messages', { channel: 'support/billing', text: 'my invoice is wrong' })
    expect(posted.body.message.by).toMatchObject({ actor: `${SUPPORT}+fix-2`, profile: 'fix-2' })
    const queue = remote.servers.at(-1)!.session(`watch:@${SUPPORT}`)
    await vi.waitFor(async () =>
      expect((await queue.history()).flatMap((event) => (event.type === 'watch.matched' ? [(event.payload as { watcher?: string }).watcher] : []))).toEqual(['fix']),
    )
  })

  it("doesn't upload for its callers: on the board it uses, a file is the project's until a message carries it", async () => {
    const { remote, project, seen } = gateway({ 'app:user:ada': { 'support/': ['read', 'post'] } })
    const julian = await julianOn(remote.fetch)
    const upload = (fetch: (request: Request) => Promise<Response>, url: string, headers: Record<string, string>) =>
      fetch(new Request(`${url}/attachments`, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: 'the invoice' }))
    const refused = await upload(project.fetch, SUPPORT_URL, { cookie: 'session=ada' })
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([403, 'forbidden'])
    expect(seen.filter((request) => new URL(request.url).pathname.endsWith('/attachments'))).toEqual([])
    // A file in a message she can read is hers to download, as any reader's.
    const { attachment } = (await (await upload(remote.fetch, BOARD_URL, { authorization: `Bearer ${await personToken()}` })).json()) as { attachment: { id: string } }
    await julian('POST', '/messages', { channel: 'support/billing', text: 'the invoice', attachments: [attachment.id] })
    const download = await project.fetch(new Request(`${SUPPORT_URL}/attachments/${attachment.id}`, { headers: { cookie: 'session=ada' } }))
    expect([download.status, await download.text()]).toEqual([200, 'the invoice'])
  })

  it('serves its callers within it, as its project on the board it uses, labeled with who they are', async () => {
    const { remote, seen, as } = gateway({ 'app:user:ada': { 'support/': ['read', 'post'] } })
    const julian = await julianOn(remote.fetch)
    await julian('POST', '/messages', { channel: 'dev', text: 'team only' })
    await julian('POST', '/messages', { channel: 'support/billing', text: 'welcome' })
    const ada = as('session=ada')

    // Who she is, the board that verified her says itself.
    expect(await ada('GET', '/me')).toMatchObject({ status: 200, body: { principal: 'app:user:ada', handle: 'ada.lovelace', can: { 'support/': ['read', 'post'] } } })
    expect(seen.map((request) => new URL(request.url).pathname)).not.toContain('/api/board/me')

    const posted = await ada('POST', '/messages', { channel: 'support/billing', text: 'my invoice is wrong' })
    expect(posted.status).toBe(201)
    // The team's board sees the project, labeled with who it was: ada via support.
    const { body } = await julian('GET', `/messages/${posted.body.message.id}`)
    expect(body.message).toMatchObject({ text: 'my invoice is wrong', by: { actor: `${SUPPORT}+ada-lovelace`, principal: SUPPORT, profile: 'ada-lovelace' } })
    expect(body.message.author).toMatchObject({ kind: 'agent', handle: 'support/ada-lovelace' })
    // Nothing of hers went with it: the project's token, her handle as its profile, and her access as its scope.
    const sent = seen.find((request) => request.method === 'POST' && request.url.endsWith('/messages'))!
    expect(sent.headers.get('authorization')).toBe(`Bearer ${await supportToken()}`)
    expect([sent.headers.get('cookie'), sent.headers.get('x-board-profile'), sent.headers.get('x-board-scope')]).toEqual([null, 'ada-lovelace', 'support/=read,post'])

    // Only what she may read, though the project reads dev too.
    expect((await ada('GET', '/messages')).body.messages.map((message: { text: string }) => message.text)).toEqual(['welcome', 'my invoice is wrong'])
    expect((await ada('POST', '/messages', { channel: 'dev', text: 'hi team' })).status).toBe(403)
    // What's the project's own there, by principal, the board it uses can't tell its callers apart for.
    expect((await ada('POST', `/messages/${posted.body.message.id}/edit`, { text: 'never mind' })).status).toBe(403)
    expect((await ada('GET', '/watchers')).status).toBe(403)
    expect((await ada('POST', '/schedules', { channel: 'support/billing', text: 'still wrong', in: '1h' })).status).toBe(403)

    // Anyone it doesn't recognize, or gives nothing, gets nothing.
    expect((await as(null)('GET', '/messages')).status).toBe(401)
    expect((await as('session=root')('GET', '/messages')).status).toBe(403)
  })

  it("can't give its callers more than the board it uses gives the project, whatever they're labeled", async () => {
    const { remote, as } = gateway({ 'app:user:root': 'all', 'app:user:ada': { 'support/': ['read', 'post'] } })
    const julian = await julianOn(remote.fetch)
    await julian('POST', '/messages', { channel: 'dev', text: 'team only' })
    const root = as('session=root')
    // Everything here is what the project may do there: read dev, and no more.
    expect((await root('GET', '/messages?channel=dev')).body.messages.map((message: { text: string }) => message.text)).toEqual(['team only'])
    expect((await root('POST', '/messages', { channel: 'dev', text: 'hi team' })).status).toBe(403)
    // Its handle is Julian's, but it's the project there, labeled: never Julian.
    const posted = (await root('POST', '/messages', { channel: 'support', text: 'from root', id: 'p1' })).body.message
    expect(posted.by).toMatchObject({ actor: `${SUPPORT}+julian`, principal: SUPPORT, profile: 'julian' })
    // A post's ID is its caller's own: the same one from someone else posts again.
    const ada = as('session=ada')
    const again = (await ada('POST', '/messages', { channel: 'support', text: 'from ada', id: 'p1' })).body.message
    expect(again.id).not.toBe(posted.id)
    expect((await root('POST', '/messages', { channel: 'support', text: 'from root', id: 'p1' })).body.message.id).toBe(posted.id)
  })
})

describe("a2()'s own writes, through board()", () => {
  it('sends a schedule as its creator through the middleware, and cancels it once access gives the creator nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const queue = fakeQueue()
    const open = { ops: true }
    const seen: Pick<MiddlewareContext, 'source' | 'author' | 'write'>[] = []
    const middleware: Middleware = ({ source, author, write, next }) => {
      seen.push({ source, author, write })
      return next({ text: `${write.text} (checked)` })
    }
    const kept = board({
      backend: a2({ store: memory(), scheduler: queue.scheduler }),
      url: BOARD_URL,
      project: { id: PROJECT_ID, teamId: TEAM_ID },
      authenticate: oidcTokens(testAuth),
      access: [(principal) => (principal.id === MARKETING ? (open.ops ? { ops: ['read', 'post'] } : null) : undefined)],
      middleware: [middleware],
    })
    // A token minted now, since the clock moves past each one's hour.
    const marketing = async (method: string, path: string, body?: unknown) => caller(kept.fetch, await deploymentToken())(method, path, body)
    const advance = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      vi.setSystemTime(Date.now() + 3_600_000)
      await queue.fire()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const created = await marketing('POST', '/schedules', { channel: 'ops', text: 'nightly check', every: '1h' })
    expect(created.status).toBe(201)
    await advance()
    await vi.waitFor(async () => expect((await marketing('GET', '/messages?channel=ops')).body.messages).toMatchObject([{ text: 'nightly check (checked)', schedule: { n: 0 } }]))
    // The middleware saw the send as any post: the schedule's, by its creator.
    const id = Number(created.body.schedule.id.replace(/^s/, ''))
    expect(seen).toMatchObject([{ source: { kind: 'schedule', id }, author: { id: MARKETING }, write: { kind: 'post', channel: 'ops', text: 'nightly check' } }])

    // board()'s access gives the creator nothing now: the next send is canceled, and never reaches the middleware.
    open.ops = false
    await advance()
    open.ops = true
    expect((await marketing('GET', '/schedules?all=1')).body.schedules).toMatchObject([{ sent: 1, state: 'canceled', canceled: { reason: 'revoked' } }])
    expect(seen).toHaveLength(1)
  })

  it("matches a registered watcher by what board()'s access lets its registrant read, at each event", async () => {
    const queue = fakeQueue()
    const can: { now: Can | null } = { now: 'all' }
    // While it's held, a wake-up gets there and the project doesn't pull: only what matched is queued.
    const wakes = { held: false }
    let project: ReturnType<typeof board>
    const remote = testBoard({
      scheduler: queue.scheduler,
      access: [(principal) => (principal.id === SUPPORT ? can.now : undefined)],
      transport: {
        post: (url, init) => (wakes.held ? Promise.resolve(Response.json({ ran: 0 })) : project.fetch(new Request(url, { method: 'POST', headers: init.headers, body: init.body }))),
      },
    })
    const { fetch } = team(remote, () => project)
    const ran: WatcherContext['event'][] = []
    const watch: Record<string, Watcher> = { triage: { tail: 'feedback', run: ({ event }) => void ran.push(event) } }
    const backend = http(BOARD_URL, { fetch })
    project = board({ backend, url: SUPPORT_URL, watch })
    await backend.registerWatchers()
    const julian = await julianOn(remote.fetch)
    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(() => expect(ran.map((event) => event.message?.text)).toEqual(['export is broken']))
    // The board's access no longer lets the project read feedback: what's posted there now isn't its
    // match, even once it may read it again by the time it pulls.
    can.now = { support: ['read'] }
    wakes.held = true
    await julian('POST', '/messages', { channel: 'feedback', text: 'import too' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    can.now = 'all'
    wakes.held = false
    await julian('POST', '/messages', { channel: 'feedback', text: 'and search' })
    await vi.waitFor(() => expect(ran.map((event) => event.message?.text)).toEqual(['export is broken', 'and search']))
  })
})
