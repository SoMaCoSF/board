import { idempotentId } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type A2Store, type ConsumerContext } from 'experimental-a2/server'
import type { BoardEventView } from '../api/routes.ts'
import { parseWatchTail } from '../api/tail.ts'
import type { BoardClient } from '../client/client.ts'
import {
  boardContract,
  registeredWatchKey,
  watchContract,
  watchSession,
  type BoardEvent,
  type BoardEvents,
} from '../contract/contract.ts'
import { actorsReducer, type Message, type MessagesState } from '../contract/reducers.ts'
import { compileFilter, eventView, foldEvent, hasCriteria, loadBefore, type ParsedFilters } from './feed.ts'
import type { BoardReads } from './reads.ts'
import type { Registration, RegistryState } from './registry.ts'
import { deploymentIdentity, type Identity, type WriteOrigin } from './writes.ts'

/** What a watcher's `run` gets. */
export type WatcherContext = {
  /** Exactly what `vb tail --json` prints. */
  event: BoardEventView
  /** Writes as this watcher. */
  board: BoardClient
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
] as const

/** Receipts: only a `--all` tail shows them. */
const RECEIPTS = new Set(['message.synced', 'message.files_synced'])

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
const KILLED_ATTEMPTS = RUN_ATTEMPTS * 2

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

export type Match = { id: string; payload: { thread: string; event: unknown } }

type Compiled = { filters: ParsedFilters; criteria: boolean; enters: boolean; all: boolean }

/** A watcher's tail, checked the way a boot checks it: errors name the watcher. */
export function compileWatcher(id: string, spec: { tail: string; when?: 'matches' | 'enters' | undefined }): Compiled {
  let filters: ParsedFilters
  let all: boolean
  try {
    ;({ filters, all } = parseWatchTail(spec.tail))
  } catch (error) {
    throw new Error(`watch ${id}: ${(error as Error).message}`)
  }
  if (filters.mentions === 'me') throw new Error(`watch ${id}: a watcher has no "me": use --mentions @handle`)
  const criteria = hasCriteria(filters)
  if (spec.when === 'enters' && !criteria) throw new Error(`watch ${id}: \`when: enters\` needs a filter to enter`)
  return { filters, criteria, enters: spec.when === 'enters', all }
}

/** A watcher to match an event against: one in config, or one a board with this as its remote registered. */
type Candidate = Compiled & {
  /** Its ID in config, or `@<owner>/<id>` for a registered one: its session is `watch:<key>`. */
  key: string
  /** Who its writes are by: an event by it never wakes it. */
  actor: string
}

/**
 * One match, on its thread's lane: `run`, retried by A2 while it fails, then
 * given up on (recorded as `watch.failed`) so the thread's next event runs.
 */
export async function runMatch(input: {
  watcher: { id: string; run: Watcher['run'] }
  match: Match
  attempt: number
  board: () => BoardClient
  record: (failure: { matched: string; thread: string; error: string }) => Promise<unknown>
}) {
  const { watcher, match, attempt } = input
  const event = match.payload.event as BoardEventView
  const giveUp = async (error: string) => {
    console.error(`[vboard] watcher ${watcher.id} gave up on event #${event.index} after ${attempt} tries:`, error)
    await input.record({ matched: match.id, thread: match.payload.thread, error })
  }
  if (attempt >= KILLED_ATTEMPTS) return giveUp(`its run was cut short ${attempt - 1} times (a timeout, or out of memory)`)
  try {
    await watcher.run({ event, board: input.board() })
  } catch (error) {
    if (attempt < RUN_ATTEMPTS) throw error
    await giveUp(describe(error))
  }
}

/** A watcher writes as itself, and its own writes never wake it. */
const identityOf = (id: string): Identity => deploymentIdentity(`vboard:watch:${id}`, id)

/**
 * Watchers: a board-contract consumer matches each event against every
 * watcher's filters, the way a tail does, and appends what matched to that
 * watcher's session, where `run` happens on the thread's lane.
 */
export function createWatchers(options: {
  watch: Record<string, Watcher>
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
  /** Watchers that boards with this board as their remote registered, and how their matches reach them. */
  registered?: {
    state: () => Promise<RegistryState>
    deliver: (registration: Registration, id: string, match: Match, signal: AbortSignal) => Promise<void>
  }
}) {
  const watchers = Object.entries(options.watch).map(([id, watcher]) => {
    if (!ID.test(id)) throw new Error(`watch: ids use lowercase letters, numbers, - and _, got: ${id}`)
    return { id, ...compileWatcher(id, watcher), identity: identityOf(id), run: watcher.run }
  })
  const byId = new Map(watchers.map((watcher) => [watcher.id, watcher]))

  let clientAs: ((identity: Identity, trigger: string, origin: WriteOrigin) => BoardClient) | null = null
  let reads: BoardReads | null = null

  /** Runs a watcher on a board event it matched, one thread at a time. */
  const runner = consumer({
    contract: watchContract,
    name: 'vboard-watch',
    types: ['watch.matched'],
    lane: ({ event }) => `thread:${event.payload.thread}`,
  }).run(async (ctx) => {
    const key = ctx.session.id.slice('watch:'.length)
    const record = (payload: { matched: string; thread: string; error: string }) =>
      ctx.session.append(`failed:${ctx.event.id}`, { type: 'watch.failed', payload })
    if (key.startsWith('@')) {
      const registered = options.registered
      const slash = key.lastIndexOf('/')
      const [owner, id] = [key.slice(1, slash), key.slice(slash + 1)]
      const registration = registered && (await registered.state()).byOwner[owner]
      // A watcher unregistered since it matched has nowhere left to go.
      if (!registered || !registration?.watch[id]) return
      await runMatch({
        watcher: { id: `${owner}/${id}`, run: () => registered.deliver(registration, id, ctx.event, ctx.signal) },
        match: ctx.event,
        attempt: ctx.attempt,
        board: () => undefined as never,
        record,
      })
      return
    }
    // A watcher removed from config since it matched has nothing left to run.
    const watcher = byId.get(key)
    if (!watcher) return
    const bound = clientAs
    if (!bound) throw new Error('watchers used before the board bound them')
    await runMatch({
      watcher,
      match: ctx.event,
      attempt: ctx.attempt,
      board: () => bound(watcher.identity, ctx.event.id, { via: { kind: 'watcher', id: watcher.id } }),
      record,
    })
  })

  const server = createServer({
    contract: watchContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [runner],
  })

  /** Matches one board event; the message before or after it must match, as in a tail. */
  const configured: Candidate[] = watchers.map((watcher) => ({ ...watcher, key: watcher.id, actor: watcher.identity.actor.id }))
  // Each registration's tails, parsed once per hash.
  const compiled = new Map<string, { hash: string; candidates: Candidate[] }>()
  function compiledFor(registration: Registration): Candidate[] {
    const hit = compiled.get(registration.owner)
    if (hit?.hash === registration.hash) return hit.candidates
    const candidates: Candidate[] = []
    for (const [id, spec] of Object.entries(registration.watch)) {
      try {
        candidates.push({
          ...compileWatcher(id, spec),
          key: registeredWatchKey(registration.owner, id),
          actor: `${registration.owner}+${id.toLowerCase()}`,
        })
      } catch (error) {
        // Checked when it was registered: only a tail this version reads differently gets here.
        console.error(`[vboard] skipping a watcher ${registration.owner} registered:`, (error as Error).message)
      }
    }
    compiled.set(registration.owner, { hash: registration.hash, candidates })
    return candidates
  }
  async function candidates(): Promise<Candidate[]> {
    if (!options.registered) return configured
    const { byOwner } = await options.registered.state()
    return [...configured, ...Object.values(byOwner).flatMap(compiledFor)]
  }

  async function dispatch(ctx: ConsumerContext<BoardEvents>) {
    const targets = await candidates()
    if (targets.length === 0) return
    const event = ctx.event as BoardEvent
    const through = event.index - 1
    const [messages, { state: actors }] = await Promise.all([
      messagesBefore(event, ctx.signal),
      ctx.session.state(actorsReducer, { through }),
    ])
    const { id, before, after } = foldEvent(messages, actors, event)
    const by = (event.payload as { by?: { actor?: string } }).by?.actor
    let view: BoardEventView | undefined
    for (const watcher of targets) {
      if (by === watcher.actor) continue
      if (RECEIPTS.has(event.type) && !watcher.all) continue
      const match = compileFilter(watcher.filters, { me: null, actors, messages })
      if (watcher.enters ? !entered(match, before, after, messages) : !(watcher.criteria ? match(before) || match(after) : id !== null))
        continue
      view ??= eventView(event, after, actors)
      await server.session(watchSession(watcher.key)).append({
        type: 'watch.matched',
        id: await idempotentId('vboard-watch', watcher.key, event.id),
        payload: { thread: (event.payload as { thread: string }).thread, event: view },
      })
    }
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

  return {
    server,
    boardConsumer,
    /** Every watcher's session: config ones, and registered ones. */
    sessions: async () => (await candidates()).map((candidate) => watchSession(candidate.key)),
    bind: (binding: { clientAs: (identity: Identity, trigger: string, origin: WriteOrigin) => BoardClient; reads: BoardReads }) => {
      clientAs = binding.clientAs
      reads = binding.reads
    },
  }
}
