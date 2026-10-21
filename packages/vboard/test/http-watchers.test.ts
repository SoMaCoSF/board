import { describe, expect, it, vi } from 'vitest'
import { board, type Watcher, type WatcherContext } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'
import { LEASE_MS } from '../src/server/registered.ts'

/** Where v0's board is mounted: a board on the team's board, over http(). */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'
const v0Token = () => deploymentToken('v0', 'prj_v0', 'production')

/**
 * The team's board on a2(), and v0's board on http() using it, calling each other in-process:
 * the team's board wakes v0's at `<V0_URL>/wake`, and v0's pulls and writes back over HTTP.
 */
function team(watch: Record<string, Watcher> = {}, can: Parameters<typeof vercelProject>[0]['can'] = 'all') {
  const queue = fakeQueue()
  const woken: string[] = []
  let down = false
  let project: ReturnType<typeof v0Board>
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    if (request.url.startsWith(V0_URL)) return project.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const remote = testBoard({
    scheduler: queue.scheduler,
    access: [vercelProject({ project: 'prj_v0', can }), vercelProject({ project: 'prj_marketing', can: 'all' })],
    transport: {
      post: (url, init) => {
        woken.push(url)
        if (down) return Promise.resolve(new Response('deploying', { status: 503 }))
        return route(url, { method: 'POST', headers: init.headers, body: init.body })
      },
    },
  })
  const v0Board = (next: Record<string, Watcher>) => {
    const backend = http(BOARD_URL, { fetch: route as typeof fetch, token: v0Token })
    // The backend's own `register`, as `POST /watchers` does.
    return Object.assign(board({ backend, url: V0_URL, watch: next }), { register: backend.register })
  }
  project = v0Board(watch)
  return {
    remote,
    queue,
    woken,
    get project() {
      return project
    },
    deploy: (next: Record<string, Watcher>) => (project = v0Board(next)),
    /** While it's down, v0's board answers wake-ups with a 503. */
    set down(value: boolean) {
      down = value
    },
    /** Fires every timer now: leases run out, and waits after an error end. */
    fireTimers: async () => {
      for (const timer of queue.timers) timer.dueAt = 0
      await queue.fire()
    },
  }
}

/** A watcher that records each event it runs on, and runs `then` after. */
function recorder(tail: string, then?: Watcher['run']) {
  const seen: WatcherContext['event'][] = []
  return { seen, watcher: { tail, run: async (context: WatcherContext) => (seen.push(context.event), then?.(context)) } satisfies Watcher }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>) => caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

/** A sweep's timer, as opposed to an error's wait. */
const isSweep = (task: { events: readonly { payload: unknown }[] }) => (task.events[0]?.payload as { sweep?: number }).sweep !== undefined

describe('watchers on http()', () => {
  it("run on what the same tail prints, woken with nothing in the wake-up, writing as the deployment's profile", async () => {
    const fix = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted' && event.message?.re === null) await board.reply(event.message.id, 'on it')
    })
    const t = team({ fix: fix.watcher })
    await t.project.register()
    const julian = await julianOn(t.remote.fetch)
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })).body.message
    await vi.waitFor(async () => {
      const { body } = await julian('GET', `/messages/${root.id}`)
      expect(body.replies.map((reply: { text: string; by: { actor: string } }) => [reply.text, reply.by.actor])).toEqual([['on it', `${V0}+fix`]])
    })
    expect(fix.seen.map((event) => [event.type, event.message?.text])).toEqual([['message.posted', 'export is broken']])
    expect(t.woken[0]).toBe(`${V0_URL}/wake`)
  })

  it('wake their board once for a burst of matches, since it pulls until nothing is left', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const fix = recorder('feedback', () => held)
    const t = team({ fix: fix.watcher })
    await t.project.register()
    const julian = await julianOn(t.remote.fetch)
    for (const n of [1, 2, 3, 4, 5]) await julian('POST', '/messages', { channel: 'feedback', text: `report ${n}` })
    // The first wake-up is still running when the rest match.
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).filter((event: { type: string }) => event.type === 'watch.matched')).toHaveLength(5))
    release()
    await vi.waitFor(() => expect(fix.seen).toHaveLength(5))
    await t.remote.servers.at(-1)!.drain(`watch:@${V0}`)
    expect(t.woken).toEqual([`${V0_URL}/wake`])
  })

  it("try a wake-up that didn't get there again, from a sweep a minute or so on", async () => {
    const fix = recorder('feedback')
    const t = team({ fix: fix.watcher })
    await t.project.register()
    t.down = true
    const julian = await julianOn(t.remote.fetch)
    await julian('POST', '/messages', { channel: 'feedback', text: 'while it deploys' })
    await vi.waitFor(() => expect(t.queue.timers.filter(isSweep)).toHaveLength(1))
    expect(fix.seen).toEqual([])
    t.down = false
    await t.fireTimers()
    await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['while it deploys']))
    expect(t.woken).toHaveLength(2)
  })

  it("never runs on what its registrant can't read", async () => {
    const fix = recorder('--all')
    const t = team({ fix: fix.watcher }, { feedback: ['read', 'post'] })
    await t.project.register()
    const julian = await julianOn(t.remote.fetch)
    await julian('POST', '/messages', { channel: 'security', text: 'hunter2' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['export is broken']))
  })

  it("doesn't wake for its own writes", async () => {
    const echo = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted') await board.post('feedback', 'echo')
    })
    const t = team({ echo: echo.watcher })
    await t.project.register()
    await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'hello' })
    await vi.waitFor(() => expect(echo.seen).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(echo.seen.map((event) => event.message?.text)).toEqual(['hello'])
  })

  it('registers again when a wake-up shows the remote holds an older registration', async () => {
    const t = team({ fix: recorder('feedback').watcher })
    await t.project.register()
    const next = recorder('feedback --label kind=bug')
    t.deploy({ fix: next.watcher })
    // The old registration still matches, and the wake-up's hash shows it's stale.
    await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
    await vi.waitFor(async () => {
      const { body } = await caller(t.remote.fetch, await v0Token())('GET', '/watchers')
      expect(body.watchers[0].watch).toEqual({ fix: { tail: 'feedback --label kind=bug', when: 'matches' } })
    })
  })

  it('ignores what a forged wake-up says: it only pulls its own', async () => {
    const t = team({ fix: recorder('feedback').watcher })
    await t.project.register()
    const forged = await t.project.fetch(new Request(`${V0_URL}/wake`, { method: 'POST', body: '{"run":"everything"}' }))
    expect(await forged.json()).toEqual({ ran: 0 })
  })

  it("pulls on its own when it can't be woken", async () => {
    const fix = recorder('feedback')
    const t = team()
    const backend = http(BOARD_URL, { fetch: ((input: RequestInfo | URL, init?: RequestInit) => t.remote.fetch(new Request(input, init))) as typeof fetch, token: v0Token })
    const local = board({ backend, url: 'http://localhost:3000/api/board', watch: { fix: fix.watcher } })
    try {
      // Nothing happens until it's first used: here, a call from the project's own code.
      expect((await caller(t.remote.fetch, await v0Token())('GET', '/watchers')).body.watchers).toEqual([])
      await local.client('deploys').me()
      await vi.waitFor(async () => {
        const { body } = await caller(t.remote.fetch, await v0Token())('GET', '/watchers')
        expect(body.watchers).toEqual([expect.objectContaining({ owner: V0, url: null })])
      })
      await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
      await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['export is broken']))
    } finally {
      backend.close()
    }
  })
})

/** The queue as v0 sees it through the API, registered without a URL so nothing wakes it. */
async function queued(tail = 'feedback') {
  const t = team()
  const v0 = caller(t.remote.fetch, await v0Token())
  expect((await v0('POST', '/watchers', { watch: { fix: { tail } } })).status).toBe(200)
  const julian = await julianOn(t.remote.fetch)
  const pull = async (headers: Record<string, string> = {}) =>
    (await caller(t.remote.fetch, await v0Token(), headers)('GET', '/watchers/matches')).body.matches as { id: string; lease: string; attempt: number; failed?: string; event: { message: { text: string } } }[]
  const ack = (match: { id: string; lease: string }, body: Record<string, unknown> = {}) => v0('POST', `/watchers/matches/${match.id}/ack`, { lease: match.lease, ...body })
  return { t, v0, julian, pull, ack }
}

describe('pulling matches', () => {
  it("hands out a thread's matches one at a time, in order", async () => {
    const { julian, pull, ack } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'first' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'second' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'another thread' })
    let matches: Awaited<ReturnType<typeof pull>> = []
    await vi.waitFor(async () => {
      matches = [...matches, ...(await pull())]
      expect(matches.map((match) => match.event.message.text).sort()).toEqual(['another thread', 'first'])
    })
    // The thread's second waits for its first.
    expect(await pull()).toEqual([])
    const first = matches.find((match) => match.event.message.text === 'first')!
    expect((await ack(first)).status).toBe(200)
    expect((await pull()).map((match) => match.event.message.text)).toEqual(['second'])
  })

  it('leases a match to one pull at a time', async () => {
    const { julian, pull } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'once' })
    await vi.waitFor(async () => {
      const both = await Promise.all([pull(), pull()])
      expect(both.flat()).toHaveLength(1)
    })
  })

  it("run a watcher's failed hook once when they give up on an event, then go on", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failures: { error: string; attempts: number }[] = []
    const t = team({
      flaky: {
        tail: 'feedback',
        run: ({ event }) => {
          if (event.message?.text === 'boom') throw new Error('sandbox setup failed')
        },
        failed: async ({ event, board, error, attempts }) => {
          failures.push({ error, attempts })
          await board.reply(event.message!.id, `couldn't start: ${error}`)
        },
      },
    })
    await t.project.register()
    const julian = await julianOn(t.remote.fetch)
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'boom' })).body.message
    await vi.waitFor(async () => {
      await t.fireTimers()
      expect(failures).toHaveLength(1)
    })
    await t.fireTimers()
    expect(failures).toEqual([{ error: 'sandbox setup failed', attempts: 5 }])
    const { body } = await julian('GET', `/messages/${root.id}`)
    expect(body.replies.map((reply: { text: string; by: { actor: string } }) => [reply.text, reply.by.actor])).toEqual([
      ["couldn't start: sandbox setup failed", `${V0}+flaky`],
    ])
    const history = await t.remote.servers.at(-1)!.session(`watch:@${V0}`).history()
    expect(history.filter((event: { type: string }) => event.type === 'watch.failed')).toHaveLength(1)
    error.mockRestore()
  })

  it('tries an error again after a wait, gives up after 5 tries, and the thread goes on', async () => {
    const { t, julian, pull, ack } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'flaky' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'after it' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(match!.attempt).toBe(attempt)
      expect((await ack(match!, { error: 'boom' })).status).toBe(200)
      if (attempt === 4) break
      // It waits out its delay before anyone can pull it again.
      expect(await pull()).toEqual([])
      await t.fireTimers()
      match = (await pull())[0]
      expect(match?.event.message.text).toBe('flaky')
    }
    // Once more at once, for the watcher's failed hook.
    const last = (await pull())[0]!
    expect([last.id, last.attempt, last.failed]).toEqual([match!.id, 5, 'boom'])
    expect((await ack(last)).status).toBe(200)
    expect((await pull()).map((next) => next.event.message.text)).toEqual(['after it'])
    const history = await t.remote.servers.at(-1)!.session(`watch:@${V0}`).history()
    expect(history.filter((event: { type: string }) => event.type === 'watch.failed')).toHaveLength(1)
  })

  it('pulls a match again once its lease runs out, and ignores the old lease', async () => {
    const { t, julian, pull, ack } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'slow' })
    let first: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((first = (await pull())[0])).toBeDefined())
    expect(await pull()).toEqual([])
    // Its puller never acks, and five minutes go by.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + LEASE_MS + 1000)
      await t.fireTimers()
      const again = (await pull())[0]!
      expect([again.id, again.attempt]).toEqual([first!.id, 1])
      expect(await ack(first!)).toEqual({ status: 409, body: { error: { code: 'stale_lease', message: 'that lease ran out, and the match was pulled again' } } })
      expect((await ack(again)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands a match whose leases keep running out to its failed hook, then gives up on it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { t, julian, pull } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'slow' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'after it' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Its puller is killed every time, and never acks: the 5th time, it's handed out for the failed hook.
      const handed: [number | undefined, string | undefined][] = []
      for (let n = 0; n < 6; n++) {
        vi.setSystemTime(Date.now() + LEASE_MS + 1000)
        match = (await pull())[0]
        handed.push([match?.attempt, match?.failed])
      }
      const cut = 'its lease ran out (a timeout, or out of memory)'
      expect(handed).toEqual([[1, undefined], [2, undefined], [3, undefined], [4, undefined], [5, cut], [undefined, undefined]])
      expect((await pull()).map((next) => next.event.message.text)).toEqual(['after it'])
    } finally {
      vi.useRealTimers()
    }
    const failed = (await t.remote.servers.at(-1)!.session(`watch:@${V0}`).history()).filter((event: { type: string }) => event.type === 'watch.failed')
    expect(failed.map((event: { payload: unknown }) => event.payload)).toEqual([
      expect.objectContaining({ error: 'its lease ran out (a timeout, or out of memory)', hook: 'its lease ran out (a timeout, or out of memory)' }),
    ])
    error.mockRestore()
  })

  it('sets one sweep a minute for its leases, however many it pulls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T12:00:10.000Z'))
    try {
      const { t, julian, pull } = await queued()
      for (const n of [1, 2, 3]) {
        await julian('POST', '/messages', { channel: 'feedback', text: `report ${n}` })
        await vi.waitFor(async () => expect(await pull()).toHaveLength(1))
      }
      // Three pulls, leases until 12:05:10, one sweep on the minute after.
      expect(t.queue.timers.filter(isSweep).map((task) => new Date(task.dueAt).toISOString())).toEqual(['2026-10-20T12:06:00.000Z'])
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a match its registrant can't read anymore", async () => {
    const { t, julian, pull } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'meant for v0' })
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.matched'))
    // A token narrowed to another channel since: the match is skipped, not handed out.
    expect(await pull({ 'x-board-scope': 'other=read' })).toEqual([])
    expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.skipped')
    expect(await pull()).toEqual([])
  })

  it('needs a registration, and acks only its own', async () => {
    const { t, julian, pull } = await queued()
    const marketing = caller(t.remote.fetch, await deploymentToken())
    expect((await marketing('GET', '/watchers/matches')).body.error.code).toBe('no_registration')
    await julian('POST', '/messages', { channel: 'feedback', text: 'for v0' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    expect((await marketing('POST', `/watchers/matches/${match!.id}/ack`, { lease: match!.lease })).status).toBe(404)
  })
})

describe('registering', () => {
  it("is checked the way a board's own watchers are", async () => {
    const t = team()
    const v0 = caller(t.remote.fetch, await v0Token())
    const register = (watch: unknown, url?: string) => v0('POST', '/watchers', { watch, ...(url ? { url } : {}) })
    expect(await register({ fix: { tail: 'feedback --after 3' } })).toEqual({
      status: 400,
      body: { error: { code: 'bad_watcher', message: "watch fix: --after isn't a filter" } },
    })
    expect((await register({ review_pi: { tail: 'prs' } })).body.error.message).toBe(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    expect((await register({}, 'http://v0.test/board')).body.error.message).toContain('wake-ups go over https')
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`w${n}`, { tail: 'feedback' }]))
    expect((await register(many)).body.error.message).toContain('at most 32 watchers')
    expect((await register({ fix: { tail: 'feedback' } }, V0_URL)).status).toBe(200)
  })

  it('needs a token that reads somewhere, and lists registrations to whoever may see them', async () => {
    const t = team({}, { feedback: ['post'] })
    const v0 = caller(t.remote.fetch, await v0Token())
    expect((await v0('POST', '/watchers', { watch: {} })).status).toBe(403)
    const marketing = caller(t.remote.fetch, await deploymentToken())
    await marketing('POST', '/watchers', { watch: { fix: { tail: 'feedback' } } })
    expect((await v0('GET', '/watchers')).body.watchers).toEqual([])
    expect((await (await julianOn(t.remote.fetch))('GET', '/watchers')).body.watchers.map((found: { owner: string }) => found.owner)).toEqual([
      'vercel:project:prj_marketing:production',
    ])
  })
})
