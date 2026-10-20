import { describe, expect, it, vi } from 'vitest'
import type { BoardEventView } from '../src/api/routes.ts'
import { createClient } from '../src/client/node.ts'
import { memory } from '../src/store/memory.ts'
import { board, vercelProject, type Watcher } from '../src/server/index.ts'
import { isPublicAddress, transport } from '../src/server/transport.ts'
import type { remoteBoard } from '../src/server/remote.ts'
import { BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, testAuth, testBoard } from './harness.ts'

/** Where v0's board is mounted: a board with the team's board as its remote. */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'
const FIX = `watch:@${V0}/fix`

/**
 * The team's board, and v0's board with it as its remote, calling each other in-process.
 * `deploy` swaps in a new deployment of v0's board: the same principal, new code.
 */
function team(watch: Record<string, Watcher> = {}, access: NonNullable<Parameters<typeof testBoard>[0]>['access'] = [vercelProject({ can: 'all' })]) {
  let project: ReturnType<typeof remoteBoard>
  /** Each delivery v0's board answered: whose registration it was for, and how it went. */
  const delivered: { owner: string | null; status: number }[] = []
  const route = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    if (request.url.startsWith(V0_URL)) {
      const response = await project.fetch(request)
      if (request.url.includes('/deliveries/')) delivered.push({ owner: request.headers.get('x-board-owner'), status: response.status })
      return response
    }
    return new Response('no such host', { status: 502 })
  }
  const v0Board = (watch: Record<string, Watcher>): ReturnType<typeof remoteBoard> =>
    board({
      remote: BOARD_URL,
      watch,
      auth: testAuth,
      transport: { fetch: route, token: (audience) => deploymentToken('v0', 'prj_v0', 'production', { audience }) },
    })
  const remote = testBoard({
    access,
    // The team board signs deliveries as its own production deployment.
    transport: { fetch: route, token: (audience) => deploymentToken('board', PROJECT_ID, 'production', { audience }) },
  })
  project = v0Board(watch)
  const watches = remote.servers.at(-1)!
  return {
    remote,
    delivered,
    get project() {
      return project
    },
    deploy: (next: Record<string, Watcher>) => (project = v0Board(next)),
    watches,
    /** Lets a failed delivery's next attempt run now: without a scheduler, each drain is the next try. */
    retry: async (session = FIX) => {
      await remote.skipHold(watches, session)
      await watches.drain(session)
    },
  }
}

/** A watcher that records every event it runs on. */
function recorder(tail: string, run?: Watcher['run']) {
  const events: BoardEventView[] = []
  const watcher: Watcher = {
    tail,
    run: async (context) => {
      events.push(context.event)
      await run?.(context)
    },
  }
  return { watcher, events, texts: () => events.map((event) => event.message?.text) }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>) =>
  caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

const ask = (fetch: (request: Request) => Promise<Response>) => fetch(new Request(`${V0_URL}/watchers`, { method: 'POST' }))

describe('a board with a remote', () => {
  it('keeps no log: what keeps one is the remote', () => {
    expect(() => board({ remote: BOARD_URL, store: memory() })).toThrow(
      'a board with a remote keeps no log: `store` goes on the remote',
    )
    expect(() => board({ remote: BOARD_URL, access: [vercelProject({ can: 'all' })] })).toThrow('`access` goes on the remote')
    // A watcher's writes are by its ID as a profile.
    expect(() => board({ remote: BOARD_URL, watch: { review_pi: { tail: 'prs', run: () => {} } } })).toThrow(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    expect(() => board({ remote: BOARD_URL, watch: { fix: { tail: 'prs --after 3', run: () => {} } } })).toThrow(
      "watch fix: --after isn't a filter",
    )
  })

  it('sends clients to its remote', async () => {
    // With a token in the environment, a client skips discovery; this is the one without.
    vi.stubEnv('VBOARD_TOKEN', '')
    const { project } = team()
    const discovery = await (await project.fetch(new Request(V0_URL))).json()
    expect(discovery).toMatchObject({ url: V0_URL, remote: BOARD_URL })

    const read = await caller(project.fetch, await personToken())('GET', '/messages')
    expect(read).toEqual({
      status: 404,
      body: { error: { code: 'remote', message: `this board keeps no log: use ${BOARD_URL}` } },
    })

    const route = (input: RequestInfo | URL, init?: RequestInit) => project.fetch(new Request(input, init))
    await expect(createClient({ url: V0_URL, fetch: route as typeof fetch }).me()).rejects.toThrow(
      `${V0_URL} keeps no log: use ${BOARD_URL}`,
    )
    vi.unstubAllEnvs()
  })

  it('registers its watchers with its remote when asked, as itself', async () => {
    const fix = recorder('feedback --label status=open')
    const { remote, project } = team({ fix: fix.watcher })
    // Anyone may ask: no body, no token.
    const asked = await ask(project.fetch)
    expect(asked.status).toBe(200)

    const julian = await julianOn(remote.fetch)
    expect((await julian('GET', '/watchers')).body.watchers).toEqual([
      {
        owner: V0,
        url: V0_URL,
        watch: { fix: { tail: 'feedback --label status=open', when: 'matches' } },
        hash: expect.any(String),
      },
    ])
    // Asking again changes nothing.
    expect((await ask(project.fetch)).status).toBe(200)
    expect((await julian('GET', '/watchers')).body.watchers).toHaveLength(1)
  })

  it("runs its watchers on what the same tail prints, writing as its deployment's profile", async () => {
    const fix = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted' && event.message?.re === null) await board.reply(event.message.id, 'on it')
    })
    const { remote, project } = team({ fix: fix.watcher })
    await project.register(V0_URL)
    const julian = await julianOn(remote.fetch)

    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })).body.message
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root.id}`)
      expect(body.replies).toEqual([
        expect.objectContaining({ text: 'on it', by: expect.objectContaining({ actor: `${V0}+fix` }) }),
      ])
    })
    // Its own reply never wakes it: the thread's next event, after it, is julian's.
    await julian('POST', '/messages', { re: root.id, text: 'thanks' })
    await vi.waitFor(() => expect(fix.texts()).toEqual(['export is broken', 'thanks']))

    const tail = await julian('GET', '/events?channel=feedback&after=0')
    expect(fix.events[0]).toEqual(tail.body.events[0])
  })

  it('posts once when a run is retried, and gives up like a run that throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let runs = 0
    const fix = recorder('feedback', async ({ event, board }) => {
      if (event.message?.text !== 'export is broken') return
      runs++
      await board.reply(event.message.id, 'on it')
      throw new Error('sandbox setup failed')
    })
    const { remote, project, watches, retry } = team({ fix: fix.watcher })
    await project.register(V0_URL)
    const julian = await julianOn(remote.fetch)
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'are you alive?' })

    await vi.waitFor(async () => {
      await retry()
      expect(fix.texts()).toContain('are you alive?')
    })
    expect(runs).toBe(5)
    // Every try posted the same reply, which landed once.
    const { body } = await julian('GET', `/messages/${root.id}`)
    expect(body.replies.filter((reply: { text: string }) => reply.text === 'on it')).toHaveLength(1)
    const failed = (await watches.session(FIX).history()).filter((event) => event.type === 'watch.failed')
    expect(failed).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ error: `${V0_URL} answered 500: sandbox setup failed` }),
      }),
    ])
    error.mockRestore()
  })

  it('brings a stale registration up to date when a delivery shows it', async () => {
    const fix = recorder('feedback')
    const triage = recorder('bugs')
    const t = team({ fix: fix.watcher })
    await t.project.register(V0_URL)
    // A deploy adds a watcher, and nobody asks the new deployment to register.
    t.deploy({ fix: fix.watcher, triage: triage.watcher })
    const julian = await julianOn(t.remote.fetch)

    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(() => expect(fix.texts()).toEqual(['export is broken']))
    // That delivery carried the old hash, so the new deployment registered triage too.
    const [registration] = (await julian('GET', '/watchers')).body.watchers
    expect(Object.keys(registration.watch)).toEqual(['fix', 'triage'])

    await julian('POST', '/messages', { channel: 'bugs', text: 'login loops' })
    await vi.waitFor(() => expect(triage.texts()).toEqual(['login loops']))
  })

  it("skips matches for a watcher the board no longer has, and stops getting them", async () => {
    const fix = recorder('feedback')
    const t = team({ fix: fix.watcher })
    await t.project.register(V0_URL)
    t.deploy({})
    const julian = await julianOn(t.remote.fetch)

    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(async () => {
      expect((await julian('GET', '/watchers')).body.watchers).toEqual([expect.objectContaining({ watch: {} })])
    })
    const history = await t.watches.session(FIX).history()
    expect(history.map((event) => event.type)).toEqual(['watch.matched'])
    expect(fix.events).toEqual([])
  })

  it("refuses deliveries its remote didn't send", async () => {
    const fix = recorder('feedback')
    const { project } = team({ fix: fix.watcher })
    const deliver = async (token: string | null, owner = V0) =>
      (
        await project.fetch(
          new Request(`${V0_URL}/deliveries/fix`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-board-owner': owner, ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ id: 'm1', event: { index: 2, type: 'message.posted' } }),
          }),
        )
      ).status

    expect(await deliver(null)).toBe(401)
    // Another project on the team, a person on the remote's own project, and a token for another URL.
    expect(await deliver(await deploymentToken('marketing', 'prj_marketing', 'production', { audience: V0_URL }))).toBe(403)
    expect(await deliver(await personToken('u_julian', V0_URL))).toBe(403)
    expect(await deliver(await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL }))).toBe(401)
    // The remote's preview, and the remote itself for someone else's registration.
    expect(await deliver(await deploymentToken('board', PROJECT_ID, 'preview', { audience: V0_URL }))).toBe(403)
    expect(await deliver(await deploymentToken('board', PROJECT_ID, 'production', { audience: V0_URL }), 'vercel:project:prj_marketing:production')).toBe(403)
    expect(fix.events).toEqual([])
    expect(await deliver(await deploymentToken('board', PROJECT_ID, 'production', { audience: V0_URL }))).toBe(200)
    expect(fix.events).toHaveLength(1)
  })

  it('writes from your own code as its deployment, idempotent by key', async () => {
    const { remote, project } = team()
    await project.client('deploys', { key: 'd1' }).post('deploys', 'a1b2c3 is live')
    await project.client('deploys', { key: 'd1' }).post('deploys', 'a1b2c3 is live')
    expect(() => project.client('deploy_bot')).toThrow('client deploy_bot: ids start with a letter')

    const { body } = await (await julianOn(remote.fetch))('GET', '/messages?channel=deploys')
    expect(body.messages).toEqual([
      expect.objectContaining({ text: 'a1b2c3 is live', by: expect.objectContaining({ actor: `${V0}+deploys` }) }),
    ])
  })
})

describe('registering with a remote', () => {
  it("is checked the way a board's own watchers are", async () => {
    const { remote } = team()
    const v0 = caller(remote.fetch, await deploymentToken('v0', 'prj_v0'))
    const register = (watch: unknown, url = V0_URL) => v0('POST', '/watchers', { url, watch })

    expect(await register({ fix: { tail: 'feedback --after 3' } })).toEqual({
      status: 400,
      body: { error: { code: 'bad_watcher', message: "watch fix: --after isn't a filter" } },
    })
    expect((await register({ fix: { tail: '--mentions' } })).body.error.message).toBe(
      'watch fix: a watcher has no "me": use --mentions @handle',
    )
    expect((await register({ review_pi: { tail: 'prs' } })).body.error.message).toBe('watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens')
    expect((await register({}, 'ftp://v0.test/board')).body.error.message).toContain('delivered over https')
    expect((await register({}, 'http://v0.test/board')).body.error.message).toContain('delivered over https')
    expect((await register({ fix: { tail: 'feedback' } })).status).toBe(200)
  })

  it("needs a token the remote trusts", async () => {
    const { remote } = team()
    const outsider = caller(remote.fetch, await deploymentToken('v0', 'prj_v0', 'production', { teamId: 'team_other' }))
    expect((await outsider('POST', '/watchers', { url: V0_URL, watch: {} })).status).toBe(403)
  })
})

const MARKETING = 'vercel:project:prj_marketing:production'

describe('what a registered watcher gets', () => {
  it("never runs a board's watchers on matches someone else registered its URL for", async () => {
    const fix = recorder('feedback')
    const t = team({ fix: fix.watcher })
    await t.project.register(V0_URL)
    // Another project on the team registers v0's URL, with a tail of its own.
    const marketing = caller(t.remote.fetch, await deploymentToken('marketing', 'prj_marketing', 'production'))
    expect((await marketing('POST', '/watchers', { url: V0_URL, watch: { fix: { tail: 'random --all' } } })).status).toBe(200)
    const julian = await julianOn(t.remote.fetch)
    await julian('POST', '/messages', { channel: 'random', text: 'lunch?' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })

    await vi.waitFor(() => expect(t.delivered).toContainEqual({ owner: MARKETING, status: 403 }))
    await vi.waitFor(() => expect(fix.texts()).toEqual(['export is broken']))
    expect(t.delivered.filter((delivery) => delivery.status === 200).map((delivery) => delivery.owner)).toEqual([V0])
  })

  it('sees only what its registrant may read, and nothing about no message unless it reads every channel', async () => {
    const fix = recorder('feedback')
    const peek = recorder('secret')
    const every = recorder('dev/ --all')
    // v0 reads and posts in feedback, reads dev but not under it, and nothing else.
    const t = team({ fix: fix.watcher, peek: peek.watcher, every: every.watcher }, [
      vercelProject({ project: 'prj_v0', can: { feedback: ['read', 'post'], dev: ['read'] } }),
      vercelProject({ can: 'all' }),
    ])
    await t.project.register(V0_URL)
    const julian = await julianOn(t.remote.fetch)
    await julian('POST', '/messages', { channel: 'secret', text: 'the key is hunter2' })
    await julian('POST', '/messages', { channel: 'dev/secret', text: 'not this either' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await julian('POST', '/messages', { channel: 'dev', text: 'deploys are green' })

    await vi.waitFor(() => expect(fix.texts()).toEqual(['export is broken']))
    await vi.waitFor(() => expect(every.texts()).toEqual(['deploys are green']))
    expect(peek.events).toEqual([])
    expect(JSON.stringify([...fix.events, ...every.events])).not.toContain('hunter2')
    // `--all` brings receipts and who's who, but about no message only to a reader of every channel.
    expect(every.events.filter((event) => !event.message)).toEqual([])
  })

  it('needs a token that reads somewhere: a watcher of one that reads nothing would see nothing', async () => {
    const { remote } = team({}, [vercelProject({ project: 'prj_ci', can: { ci: ['post'] } }), vercelProject({ can: 'all' })])
    const ci = caller(remote.fetch, await deploymentToken('ci', 'prj_ci'))
    const refused = await ci('POST', '/watchers', { url: 'https://ci.test/api/board', watch: {} })
    expect(refused).toMatchObject({ status: 403, body: { error: { message: expect.stringContaining("can't read anywhere") } } })
  })

  it('lists every registration to a manager of every channel, and its own to anyone else', async () => {
    const { remote } = team({}, [vercelProject({ project: 'prj_ci', can: { ci: ['read'] } }), vercelProject({ can: 'all' })])
    const ci = caller(remote.fetch, await deploymentToken('ci', 'prj_ci'))
    const marketing = caller(remote.fetch, await deploymentToken('marketing', 'prj_marketing'))
    await ci('POST', '/watchers', { url: 'https://ci.test/api/board', watch: { deploys: { tail: 'ci' } } })
    await marketing('POST', '/watchers', { url: 'https://marketing.test/api/board', watch: {} })
    expect((await ci('GET', '/watchers')).body.watchers.map((found: { owner: string }) => found.owner)).toEqual(['vercel:project:prj_ci:production'])
    const julian = await julianOn(remote.fetch)
    expect((await julian('GET', '/watchers')).body.watchers.map((found: { owner: string }) => found.owner)).toEqual([
      'vercel:project:prj_ci:production',
      MARKETING,
    ])
  })
})

describe('a delivery', () => {
  it('goes only to a public address, over https, wherever a name resolves', async () => {
    const internal = ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']
    expect(internal.filter(isPublicAddress)).toEqual([])
    expect(['8.8.8.8', '76.76.21.21', '2606:4700::1111'].every(isPublicAddress)).toBe(true)
    const { deliver } = transport()
    const init = { headers: {}, body: '{}', signal: AbortSignal.timeout(5000) }
    await expect(deliver('http://example.com/api/board/deliveries/fix', init)).rejects.toThrow('over https')
    await expect(deliver('https://127.0.0.1/deliveries/fix', init)).rejects.toThrow("isn't a public address")
    await expect(deliver('https://[::1]/deliveries/fix', init)).rejects.toThrow("isn't a public address")
    await expect(deliver('https://localhost/deliveries/fix', init)).rejects.toThrow("isn't a public address")
  })
})
