import { A2Error, idempotentId } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import type { BoardEventView, OnceView } from '../api/routes.ts'
import type { Board } from './board.ts'
import { boardContract, onceSession, watchContract, watchSession, type BoardEvent, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, type Message, type MessagesState } from '../contract/reducers.ts'
import type { Json } from '../contract/schemas.ts'
import { FULL_ACCESS, type Access } from './access.ts'
import { compileFilter, eventView, foldEvent, loadBefore, OWN_CODE, view as messageView } from './feed.ts'
import { compileWatcher, type Compiled } from './watch-spec.ts'
import type { BoardReads } from './reads.ts'
import { arm, due, hasWork, queueReducer, SWEEP_MS, type QueueSession } from './registered.ts'
import type { Registration, RegistryState, StoredPrincipal } from './registry.ts'
import { A2_TRIES, afterRetry } from './attempts.ts'

/** What a watcher's `run` gets. */
export type WatcherContext = {
  /** Exactly what `vb tail --json` prints. */
  event: BoardEventView
  /** The board, acting as this watcher. */
  board: Board
  /**
   * Runs `fn` unless this watcher already finished it for `key`, and returns the recorded result
   * either way: JSON, at most 16 KB. At least once: a run that dies before the record runs `fn`
   * again. Keys are the watcher's, across events and threads, and nothing locks one.
   */
  once<T extends Json | void>(key: string, fn: () => Promise<T>): Promise<T>
}

/** What a watcher's `failed` gets: the event it gave up on, and why. */
export type WatcherFailure = WatcherContext & {
  /** The last try's error, or why its tries never finished: a timeout, or out of memory. */
  error: string
  /** How many tries `run` got. */
  attempts: number
}

/** A `vb tail` the board runs for you: every event the tail would print, handed to `run`. */
export type Watcher = {
  /**
   * A `vb tail` expression without `vb tail`: `firehose --label status=needs-agent`. `--all` adds
   * delivery receipts, as in `vb tail`: `message.synced` says where a message landed on a platform.
   */
  tail: string
  /**
   * `matches` (the default) runs on every event the tail prints. `enters` runs only when a
   * message enters the view: it didn't match before the event and does after it.
   */
  when?: 'matches' | 'enters'
  run: (context: WatcherContext) => unknown
  /**
   * Runs once when the watcher gives up on an event, after `run` kept throwing or kept getting cut
   * short. Its posts get IDs of their own, so they never collide with what `run` posted. A throw
   * here is recorded with the failure, and the thread goes on.
   */
  failed?: (context: WatcherFailure) => unknown
}

export const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The events a tail shows, receipts included for `--all`: each concerns a message, and carries its thread for the lane. */
const WATCHED = [
  'message.posted',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'labels.changed',
  'message.sync_failed',
  'message.synced',
  'message.files_synced',
  'thread.synced',
] as const

/** Receipts: only a `--all` tail shows them. */
const RECEIPTS = new Set(['message.synced', 'message.files_synced'])

/**
 * What a registrant's sync gets, in every channel where it may sync: what it delivers to platforms,
 * and a thread's new targets. A tail never shows `thread.synced`, so no watcher gets it.
 */
const SYNCED = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'thread.synced'])

/** Whether a match waits in a registrant's queue for it to pull, as opposed to a config watcher's, which runs here. */
const queued = (payload: { watcher?: string | undefined; sync?: true | undefined; inbox?: string | undefined }) =>
  payload.watcher !== undefined || payload.sync === true || payload.inbox !== undefined

/**
 * A2 dead-letters an event after 10 failures, and a dead letter stops its
 * lane, which is the thread's: the watcher would never run on that thread
 * again. So `run` gets a few tries, then the failure is recorded and the
 * thread moves on.
 */
const RUN_ATTEMPTS = 5

/**
 * A run that's killed (a timeout, out of memory) never throws. A2 counts it
 * toward the 10 failures when the next attempt takes over, and dead-letters
 * the event at that takeover instead of running it: the 10th attempt is the
 * last one a watcher sees. Throws give up at RUN_ATTEMPTS, so getting this far
 * means runs keep dying, and the 10th records the failure without running.
 */
const KILLED_ATTEMPTS = A2_TRIES

/** Tries at a wake-up before it's left to the next match or sweep, well short of A2's dead letter. */
const WAKE_TRIES = 3

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

type Match = { id: string; payload: { thread: string; event: unknown } }

/**
 * One match, on its thread's lane: `run`, retried by A2 while it fails, then
 * given up on: the watcher's `failed` hook runs, then `watch.failed` is recorded
 * so the thread's next event runs. A hook cut short runs again on the next try.
 */
export async function runMatch(input: {
  watcher: {
    id: string
    run: (event: BoardEventView) => unknown
    failed: (event: BoardEventView, failure: { error: string; attempts: number }) => unknown
  }
  match: Match
  attempt: number
  record: (failure: { matched: string; thread: string; error: string; hook?: string }) => Promise<unknown>
}) {
  const { watcher, match, attempt } = input
  const event = match.payload.event as BoardEventView
  const giveUp = async (error: string, attempts: number) => {
    console.error(`[vboard] watcher ${watcher.id} gave up on event #${event.cursor} after ${attempt} tries:`, error)
    let hook: string | undefined
    try {
      await watcher.failed(event, { error, attempts })
    } catch (thrown) {
      console.error(`[vboard] watcher ${watcher.id}'s failed hook threw on event #${event.cursor}:`, thrown)
      hook = describe(thrown)
    }
    await input.record({ matched: match.id, thread: match.payload.thread, error, ...(hook === undefined ? {} : { hook }) })
  }
  const early = !afterRetry(attempt)
  if (early && attempt >= KILLED_ATTEMPTS) return giveUp(`its run was cut short ${attempt - 1} times (a timeout, or out of memory)`, attempt - 1)
  try {
    await watcher.run(event)
  } catch (error) {
    if (!early || attempt < RUN_ATTEMPTS) throw error
    await giveUp(describe(error), attempt)
  }
}

/** A watcher writes as `vboard:watch:<id>`, and its own writes never wake it. */
const actorOf = (id: string) => `vboard:watch:${id}`

export { compileWatcher }

/** A watcher to match an event against: one in config, or one a board on `http()` registered. */
type Candidate = Compiled & {
  id: string
  /** Who its writes are by: an event by it never wakes it. */
  actor: string
  /** A registered one's registration, whose principal decides what it may see. Config ones see everything. */
  registration?: Registration
}

/** `watch:@<principal>`: everything one registrant's watchers matched, queued for it to pull. */
export const registrantSession = (owner: string) => watchSession(`@${owner}`)

/**
 * Watchers: a board-contract consumer matches each event against every
 * watcher's filters, the way a tail does, and appends what matched to that
 * watcher's session, where `run` happens on the thread's lane.
 */
export function createWatchers(options: {
  /** This project's watchers, by ID. */
  watch: Record<string, { tail: string; when: 'matches' | 'enters' }>
  /** Runs one on an event it matched; posts it makes get IDs derived from `trigger`. A throw is retried. */
  run: (id: string, event: BoardEventView, trigger: string, attempt: number) => Promise<void>
  /** Runs one's `failed` hook once it gives up on an event; posts it makes get IDs derived from `trigger`. */
  failed: (id: string, event: BoardEventView, trigger: string, failure: { error: string; attempts: number }) => Promise<void>
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
  /** Watchers that boards on `http()` registered here, and how to tell one it has matches. */
  registered?: {
    state: () => Promise<RegistryState>
    /** What a registrant may do now, under the rules as they are: null once it may do nothing. */
    accessNow: (principal: StoredPrincipal) => Promise<Access | null>
    /** Tells a registrant's board it has something to pull, and says whether that got there. Never throws. */
    wake: (registration: Registration) => Promise<boolean>
  }
}) {
  const watchers = Object.entries(options.watch).map(([id, watcher]) => {
    if (!ID.test(id)) throw new Error(`watch: ids use lowercase letters, numbers, - and _, got: ${id}`)
    return { id, ...compileWatcher(id, watcher) }
  })
  const byId = new Map(watchers.map((watcher) => [watcher.id, watcher]))

  let reads: BoardReads | null = null

  /** Runs a watcher on a board event it matched, one thread at a time. */
  const runner = consumer({
    contract: watchContract,
    name: 'vboard-watch',
    types: ['watch.matched'],
    lane: ({ event }) => `thread:${event.payload.thread}`,
  }).run(async (ctx) => {
    // A registered watcher's matches are its registrant's to pull; a config watcher removed
    // since it matched has nothing left to run.
    const watcher = byId.get(ctx.session.id.slice('watch:'.length))
    if (!watcher) return
    await runMatch({
      watcher: {
        id: watcher.id,
        run: (event) => options.run(watcher.id, event, ctx.event.id, ctx.attempt),
        failed: (event, failure) => options.failed(watcher.id, event, `failed:${ctx.event.id}`, failure),
      },
      match: ctx.event,
      attempt: ctx.attempt,
      record: (payload) => ctx.session.append(ctx.event.id, { type: 'watch.failed', payload }),
    })
  })

  /**
   * Wakes a registrant's board when it has something to pull: a new match, a wait after an error
   * that's over, or a sweep that finds a lease ran out. A registrant's wake-ups go one at a time,
   * and only when there's something to pull: its board pulls until nothing's left, so a burst of
   * matches wakes it once.
   */
  const waker = consumer({
    contract: watchContract,
    name: 'vboard-wake',
    types: ['watch.matched', 'watch.due'],
    // A config watcher's match runs here, in its own session: nothing to wake. Neither does a push
    // to an inbox, whose registrant pulls it right after: only its retries and sweeps wake it.
    lane: ({ event }) => ('thread' in event.payload && (!queued(event.payload) || event.payload.inbox !== undefined) ? null : 'wake'),
  }).run(async (ctx) => {
    const key = ctx.session.id.slice('watch:'.length)
    const registered = options.registered
    if (!key.startsWith('@') || !registered) return
    if (ctx.event.type === 'watch.matched' && (!queued(ctx.event.payload) || ctx.event.payload.inbox !== undefined)) return
    // Its queue's own appends and timers: a consumer's session names each one, which these don't need.
    const queue = server.session(ctx.session.id) as unknown as QueueSession
    try {
      const state = ctx.event.type === 'watch.due' ? await due(queue, ctx.event.payload) : (await queue.state(queueReducer)).state
      if (!hasWork(state, Date.now())) return
      const registration = (await registered.state()).byOwner[key.slice(1)]
      // One without a URL pulls on its own.
      if (!registration || registration.url === null) return
      // One that didn't get it hears again from a sweep, a minute or so on.
      if (!(await registered.wake(registration)) && options.scheduler) await arm(queue, state, Date.now() + SWEEP_MS)
    } catch (error) {
      // Ten failures would dead-letter this lane, and the registrant would never be woken again.
      // The queue keeps every match, so the next match or sweep wakes it for this one too.
      if (ctx.attempt < WAKE_TRIES) throw error
      console.error(`[vboard] couldn't wake the board of ${key.slice(1)}:`, (error as Error).message)
    }
  })

  const server = createServer({
    contract: watchContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [runner, waker],
  })

  const configured: Candidate[] = watchers.map((watcher) => ({ ...watcher, actor: actorOf(watcher.id) }))
  // Each registration's tails, parsed once per hash and principal.
  const compiled = new Map<string, { version: string; candidates: Candidate[] }>()
  function compiledFor(registration: Registration): Candidate[] {
    // A new principal changes what it may see, so it compiles again too.
    const version = `${registration.hash}\u001f${JSON.stringify(registration.principal)}`
    const hit = compiled.get(registration.owner)
    if (hit?.version === version) return hit.candidates
    const candidates: Candidate[] = []
    for (const [id, spec] of Object.entries(registration.watch)) {
      try {
        candidates.push({ ...compileWatcher(id, spec), id, actor: `${registration.owner}+${id.toLowerCase()}`, registration })
      } catch (error) {
        // Checked when it was registered: only a tail this version reads differently gets here.
        console.error(`[vboard] skipping a watcher ${registration.owner} registered:`, (error as Error).message)
      }
    }
    compiled.set(registration.owner, { version, candidates })
    return candidates
  }
  async function registrations(): Promise<Registration[]> {
    return options.registered ? Object.values((await options.registered.state()).byOwner) : []
  }

  /** Matches one board event; the message before or after it must match, as in a tail. */
  async function dispatch(ctx: ConsumerContext<BoardEvents>) {
    const event = ctx.event as BoardEvent
    const through = event.index - 1
    const [messages, { state: actors }] = await Promise.all([
      messagesBefore(event, ctx.signal),
      ctx.session.state(actorsReducer, { through }),
    ])
    const { id, before, after } = foldEvent(messages, actors, event)
    const by = (event.payload as { by?: { actor?: string } }).by?.actor
    const message = after ?? before
    const thread = (event.payload as { thread: string }).thread
    let view: BoardEventView | undefined
    /** Each session's matches, appended together: one append per watcher in config, one per registrant. */
    const appends = new Map<string, { type: 'watch.matched'; id: string; payload: { thread: string; event: unknown; watcher?: string; sync?: true } }[]>()
    const add = (session: string, matched: { type: 'watch.matched'; id: string; payload: { thread: string; event: unknown; watcher?: string; sync?: true } }) =>
      (appends.get(session) ?? appends.set(session, []).get(session)!).push(matched)
    const registered = await registrations()
    const targets = [...configured, ...registered.flatMap(compiledFor)]
    // Each registrant's access, worked out once per event.
    const registrants = new Map<string, Promise<Access | null>>()
    const accessOf = (registration: Registration) => {
      let found = registrants.get(registration.owner)
      if (!found) registrants.set(registration.owner, (found = options.registered!.accessNow(registration.principal)))
      return found
    }
    for (const watcher of targets) {
      if (event.type === 'thread.synced') break
      if (by === watcher.actor) continue
      if (RECEIPTS.has(event.type) && !watcher.all) continue
      const { registration } = watcher
      let access: Access = FULL_ACCESS
      if (registration) {
        const now = await accessOf(registration)
        // A registered watcher sees what its registrant may read, as `/events` shows it: an event
        // about a message only where it reads the message's channel, one about none only if it reads all.
        if (!now || (id === null ? !now.readsAll : !message || !now.readable(message.channel))) continue
        access = now
      }
      const match = compileFilter(watcher.filters, { me: null, actors, messages, access })
      if (watcher.enters ? !entered(match, before, after, messages) : !(watcher.criteria ? match(before) || match(after) : id !== null))
        continue
      const key = registration ? `@${registration.owner}/${watcher.id}` : watcher.id
      const shown = registration
        ? eventView(event, after, actors, await reads!.reader(access, after ? [after] : []))
        : (view ??= eventView(event, after, actors, OWN_CODE))
      const session = registration ? registrantSession(registration.owner) : watchSession(watcher.id)
      add(session, {
        type: 'watch.matched',
        id: await idempotentId('vboard-watch', key, event.id),
        payload: { thread, event: shown, ...(registration ? { watcher: watcher.id } : {}) },
      })
    }
    // A registrant's sync, in the channels where it may sync: a thread's sync is about its root.
    const syncing = SYNCED.has(event.type) ? registered.filter((registration) => registration.sync.length > 0) : []
    if (syncing.length > 0) {
      const about = event.type === 'thread.synced' ? await rootOf(event.payload.thread, event.index, ctx.signal) : message
      for (const registration of syncing) {
        const now = await accessOf(registration)
        if (!now || !about || !now.can('sync', about.channel)) continue
        const reader = await reads!.reader(now, [about, ...(before ? [before] : [])])
        // A label change re-renders a copy only when the labels change what it shows: sync compares them.
        const shown = { ...eventView(event, about, actors, reader), ...(event.type === 'labels.changed' && before ? { before: messageView(before, actors, reader) } : {}) }
        add(registrantSession(registration.owner), {
          type: 'watch.matched',
          id: await idempotentId('vboard-watch', `@${registration.owner}/@sync`, event.id),
          payload: { thread, event: shown, sync: true },
        })
      }
    }
    await Promise.all(
      [...appends].map(async ([session, events]) => {
        try {
          await server.session(session).append(...events)
        } catch (error) {
          // A retry after a registration changed brings matches the first try didn't: each on its own.
          if (!(error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH')) throw error
          for (const matched of events) await server.session(session).append(matched)
        }
      }),
    )
  }

  /** A thread's root, as the board has it once the tables reach `index`: the event that synced it comes after it. */
  async function rootOf(thread: string, index: number, signal: AbortSignal): Promise<Message | undefined> {
    if (!reads) throw new Error('watchers used before the board bound them')
    await reads.ensure(index - 1, signal)
    return (await reads.tables.byEventId(thread)) ?? undefined
  }

  /** The message `event` concerns, and its thread's root, as they were just before it. */
  async function messagesBefore(event: BoardEvent, signal: AbortSignal): Promise<MessagesState> {
    if (!reads) throw new Error('watchers used before the board bound them')
    return loadBefore(reads, event, signal)
  }

  /** Didn't match before and does now; a new reply only counts if its thread wasn't already in view. */
  function entered(
    match: (message: Message | undefined) => boolean,
    before: Message | undefined,
    after: Message | undefined,
    messages: MessagesState,
  ) {
    if (match(before) || !match(after)) return false
    const root = before === undefined && after!.re !== null ? messages.byId[after!.re] : undefined
    return !match(root)
  }

  /**
   * Matches board events against the watchers, on the same per-thread lanes as
   * sync's but with its own place in the log: a watcher that fails holds up
   * neither sync nor any other thread.
   */
  const boardConsumer = consumer({
    contract: boardContract,
    name: 'vboard-watchers',
    types: WATCHED,
    lane: ({ event }) => `thread:${(event.payload as { thread: string }).thread}`,
  }).run(dispatch)

  /** An actor's record for one key: its own session, holding at most one event, so a read costs the same however many keys there are. */
  const recordOf = async (actor: string, key: string) => {
    const id = await idempotentId('vboard-once', actor, key)
    return { id, session: server.session(onceSession(id)) }
  }
  const onceView = ({ key, result }: { key: string; result?: Json | undefined }): OnceView => (result === undefined ? { key } : { key, result })
  async function readOnce(actor: string, key: string): Promise<OnceView | null> {
    const [found] = await (await recordOf(actor, key)).session.history()
    return found?.type === 'watch.once' ? onceView(found.payload) : null
  }
  /** The first record stands: the same one again replays, and another is A2's duplicate, answered with the one that stands. */
  async function recordOnce(actor: string, key: string, result: Json | undefined): Promise<OnceView> {
    const { id, session } = await recordOf(actor, key)
    const payload = { actor, key, ...(result === undefined ? {} : { result }) }
    try {
      await session.append({ type: 'watch.once', id, payload })
      return onceView(payload)
    } catch (error) {
      if (!(error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH')) throw error
    }
    return (await readOnce(actor, key))!
  }

  return {
    server,
    boardConsumer,
    /** `once`'s records, by the actor they're kept for. */
    once: { read: readOnce, record: recordOnce },
    bind: (binding: { reads: BoardReads }) => {
      reads = binding.reads
    },
  }
}
