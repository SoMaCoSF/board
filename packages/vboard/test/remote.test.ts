import { describe, expect, it, vi } from 'vitest'
import type { BoardEventView } from '../src/api/routes.ts'
import { createClient } from '../src/client/node.ts'
import { memory } from '../src/store/memory.ts'
import { board, vercel, type Watcher } from '../src/server/index.ts'
import type { remoteBoard } from '../src/server/remote.ts'
import { BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, testAuth, testBoard } from './harness.ts'

/** Where v0's board is mounted: a board with the team's board as its remote. */
const V0_URL = 'http://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'
const FIX = `watch:@${V0}/fix`

/**
 * The team's board, and v0's board with it as its remote, calling each other in-process.
 * `deploy` swaps in a new deployment of v0's board: the same principal, new code.
 */
function team(watch: Record<string, Watcher> = {}) {
  let project: ReturnType<typeof remoteBoard>
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    if (request.url.startsWith(V0_URL)) return project.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const v0Board = (watch: Record<string, Watcher>): ReturnType<typeof remoteBoard> =>
    board({
      remote: BOARD_URL,
      watch,
      auth: testAuth,
      transport: { fetch: route, token: (audience) => deploymentToken('v0', 'prj_v0', 'production', { audience }) },
    })
  const remote = testBoard({
    trustedSources: [vercel()],
    // The team board signs deliveries as its own production deployment.
    transport: { fetch: route, token: (audience) => deploymentToken('board', PROJECT_ID, 'production', { audience }) },
  })
  project = v0Board(watch)
  const watches = remote.servers.at(-1)!
  return {
    remote,
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
    expect(() => board({ remote: BOARD_URL, trustedSources: [vercel()] })).toThrow('`trustedSources` goes on the remote')
    // A watcher's writes are by its ID as a profile.
    expect(() => board({ remote: BOARD_URL, watch: { review_pi: { tail: 'prs', run: () => {} } } })).toThrow(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    expect(() => board({ remote: BOARD_URL, watch: { fix: { tail: 'prs --after 3', run: () => {} } } })).toThrow(
      "watch fix: --after isn't a filter",
    )
  })

  it('sends clients to its remote', async () => {
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
    const deliver = async (token: string | null) =>
      (
        await project.fetch(
          new Request(`${V0_URL}/deliveries/fix`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ id: 'm1', event: { index: 2, type: 'message.posted' } }),
          }),
        )
      ).status

    expect(await deliver(null)).toBe(401)
    // Another project on the team, a person on the remote's own project, and a token for another URL.
    expect(await deliver(await deploymentToken('marketing', 'prj_marketing', 'production', { audience: V0_URL }))).toBe(403)
    expect(await deliver(await personToken('u_julian', V0_URL))).toBe(403)
    expect(await deliver(await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL }))).toBe(401)
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
    expect((await register({}, 'ftp://v0.test/board')).body.error.message).toContain('delivered over http(s)')
    expect((await register({ fix: { tail: 'feedback' } })).status).toBe(200)
  })

  it("needs a token the remote trusts", async () => {
    const { remote } = team()
    const outsider = caller(remote.fetch, await deploymentToken('v0', 'prj_v0', 'production', { teamId: 'team_other' }))
    expect((await outsider('POST', '/watchers', { url: V0_URL, watch: {} })).status).toBe(403)
  })
})
