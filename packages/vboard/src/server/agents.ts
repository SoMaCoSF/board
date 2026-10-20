import { idempotentId, reducer } from 'experimental-a2'
import { inputs, type AIState, type UIMessage } from 'experimental-a2/ai'
import { createServer, type A2Scheduler, type A2Server, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { BoardEventView, NotificationView } from '../api/routes.ts'
import { parseWatchTail } from '../api/tail.ts'
import { readableText, type BoardClient } from '../client/client.ts'
import { agentSession, agentsContract, type AgentNotification, type BoardEvent, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, messagesReducer, own, setOwn, subscriptionOf, subscriptionsReducer, type ActorsState } from '../contract/reducers.ts'
import { agentKeyOf, isBoardActor, type ActorKind } from '../contract/schemas.ts'
import type { AgentIdentity, DeclaredAgent, DeclaredAgents } from './actors.ts'
import { FULL_ACCESS } from './access.ts'
import { compileFilter, eventView, foldEvent, hasCriteria, OWN_CODE, type ParsedFilters } from './feed.ts'

/** What reaches an agent from a thread it follows: anything that happens to its messages. */
export const THREAD_EVENTS = ['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed'] as const
export type ThreadEvent = (typeof THREAD_EVENTS)[number]

/** An agent from `agent()` in `experimental-a2/ai/server`. The board wakes it in its sessions. */
// A2's server type is generic over the agent's own events, which the board doesn't need to know.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type A2Agent = A2Server<any, Record<never, never>, any>

/** What `notify` and `session` decide on: a board event for the agent, and where it stands in the thread. */
export type NotifyContext = {
  /** The board event, as `vb tail --json` prints it. */
  event: BoardEventView
  /** The thread: its root's ID and labels, and its channel. */
  thread: { id: number; channel: string; labels: Record<string, string> }
  /**
   * Who did it, as the board verified it: `principal` is the credential (`slack:user:U0456`,
   * `vercel:user:…`). Decide here who may wake an agent that can change things.
   */
  author: { actor: string; principal: string; kind: ActorKind; handle: string; name: string }
  /** A post, or an edit, that mentions this agent. */
  isMentioned: boolean
  /** The agent followed the thread before this event. */
  isSubscribed: boolean
  /** The agent's `watch` matched it. */
  isWatched: boolean
  /** The agent's session that last took part in the thread, if one has: where its notifications go by default. */
  session: string | null
}

/** What a function `run` gets each time a notification reaches the agent. */
export type AgentRunContext = {
  /** The session it's for. */
  session: string
  /** The board, as the agent in this session: its writes are the agent's, and `notifications()` reads the session's inbox. */
  board: BoardClient
  /** The notification that woke it. The session may have more: `board.notifications()`. */
  notification: NotificationView
  /** 1 on the first try; the board tries 5 times. */
  attempt: number
}

/** How the board runs an agent with a harness of your own. */
export type AgentRun = (context: AgentRunContext) => Promise<void> | void

/** One of `board({ agents })`: who the agent is, when it wakes, and how. */
export type AgentConfig = AgentIdentity & {
  /** Also wake on what this tail matches, as a watcher would: `prs --label pr`. `--mentions` alone means this agent. */
  watch?: string
  /**
   * Whether a notification reaches the agent: everything does by default (its mentions, its `watch`, and
   * what happens in the threads it follows). The board's own watchers and clients never wake one.
   */
  notify?: (context: NotifyContext) => boolean | Promise<boolean>
  /**
   * Which of the agent's sessions a notification goes to. By default, the session that last took part in
   * the thread, else one per thread: `({ session, thread }) => session ?? \`thread-${thread.id}\``.
   * A string sends everything to one session, one inbox, the way a person has one.
   */
  session?: string | ((context: NotifyContext) => string)
  /**
   * How the board wakes it: an A2 agent, which gets "You have N new notifications", or a function per
   * notification, for a harness of your own. Without one, the agent runs elsewhere and reads its
   * notifications itself (`vb notifications`).
   */
  run?: A2Agent | AgentRun
}

/** An entry of `board({ agents })`: an A2 agent alone, or its config. */
export type AgentEntry = A2Agent | AgentConfig

export const isA2Agent = (value: unknown): value is A2Agent =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as A2Agent).session === 'function' &&
  typeof (value as { contract?: { name?: unknown } }).contract?.name === 'string'

/** Each entry as a config: an A2 agent alone is `{ run: agent }`. */
export function agentConfigs(entries: Record<string, AgentEntry> | undefined): Record<string, AgentConfig> {
  return Object.fromEntries(Object.entries(entries ?? {}).map(([key, entry]) => [key, isA2Agent(entry) ? { run: entry } : entry]))
}

/** What the board gives its agents to write with. */
export type AgentsBinding = {
  /** A client writing as the agent: `key` makes its posts idempotent, `session` is recorded on its writes. */
  client(agent: DeclaredAgent, options: { key?: string; session?: string }): BoardClient
  /** The board's own reply in a thread, never the agent's. It never wakes an agent. */
  notice(agent: DeclaredAgent, thread: number, text: string, key: string): Promise<void>
}

/**
 * The A2 agents boards run, by their contract's name: how `vb` from `vboard/tools`, running inside one,
 * finds the board and the agent it acts as. A newer board replaces an older one's entry.
 */
export const RUNNING_AGENTS = new Map<string, { contract: A2Agent['contract']; client(options: { key?: string; session?: string }): BoardClient }>()

const RUN_ATTEMPTS = 5
/** The most unread notifications a session keeps; older ones fall off. */
const INBOX_MAX = 500
const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

type Unread = { index: number; createdAt: number; notification: AgentNotification }
type Inbox = { unread: Unread[]; read: number }

/** Each session's unread notifications, and how far it has read. */
export const inboxReducer = reducer({ contract: agentsContract, name: 'vboard.agent-inbox.v1', initialState: {} as Record<string, Inbox> }).fold(
  (state, event) => {
    if (event.type !== 'agent.delivered' && event.type !== 'agent.read') return state
    let inbox = own(state, event.payload.session)
    if (!inbox) setOwn(state, event.payload.session, (inbox = { unread: [], read: 0 }))
    if (event.type === 'agent.delivered') {
      inbox.unread.push({ index: event.index, createdAt: new Date(event.createdAt).getTime(), notification: event.payload.notification })
      if (inbox.unread.length > INBOX_MAX) inbox.unread.splice(0, inbox.unread.length - INBOX_MAX)
    } else if (event.payload.through > inbox.read) {
      const read = event.payload.through
      inbox.read = read
      inbox.unread = inbox.unread.filter((item) => item.index > read)
    }
    return state
  },
)

const notificationView = ({ index, createdAt, notification }: Unread): NotificationView => ({
  id: index,
  createdAt: new Date(createdAt).toISOString(),
  ...notification,
})

/** `#dev`, `#dev and #ops`, `#dev, #ops, and #www`. */
const channelList = (channels: string[]) => {
  const named = channels.map((channel) => `#${channel}`)
  return named.length <= 2 ? named.join(' and ') : `${named.slice(0, -1).join(', ')}, and ${named.at(-1)}`
}

/** The wakeup an A2 agent gets: how many, where, and how to read them. Never what they say. */
export function wakeText(unread: readonly { notification: { channel: string } }[]) {
  const channels = channelList([...new Set(unread.map((item) => item.notification.channel))])
  return unread.length === 1
    ? `You have 1 new notification in ${channels}. Read it with \`vb notifications\`.`
    : `You have ${unread.length} new notifications in ${channels}. Read them with \`vb notifications\`.`
}

/**
 * The agents of a board. A board-contract handler finds each event that mentions one, matches its
 * `watch`, or happens in a thread it follows, and records it in the agent's `agent:<key>` session with the
 * session it goes to. There, one session at a time, `notify` decides, the notification lands in that
 * session's inbox, and the board wakes the agent.
 */
export function createAgents(options: {
  config: Record<string, AgentConfig>
  declared: DeclaredAgents
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
  mentionable: (actors: ActorsState) => ActorsState
}) {
  type Entry = { agent: DeclaredAgent; config: AgentConfig; watch: { filters: ParsedFilters; criteria: boolean } | null }
  const entries: Entry[] = Object.entries(options.config).map(([key, config]) => {
    let watch: Entry['watch'] = null
    if (config.watch !== undefined) {
      try {
        const { filters } = parseWatchTail(config.watch)
        watch = { filters, criteria: hasCriteria(filters) }
      } catch (error) {
        throw new Error(`agents ${key}: watch: ${(error as Error).message}`)
      }
    }
    return { agent: options.declared.get(key)!, config, watch }
  })
  const byKey = new Map(entries.map((entry) => [entry.agent.key, entry]))

  let binding: AgentsBinding | null = null
  const bound = () => {
    if (!binding) throw new Error('agents used before the board bound them')
    return binding
  }

  const contextOf = (payload: {
    root: { id: number; labels: Record<string, string> }
    event: unknown
    reason: AgentNotification['reason']
    subscribed: boolean
    engaged: string | null
  }): NotifyContext => {
    const event = payload.event as BoardEventView
    const message = event.message!
    const actor = event.actor
    const by = (event.payload as { by: { actor: string; principal: string } }).by
    return {
      event,
      thread: { id: payload.root.id, channel: message.channel, labels: payload.root.labels },
      author: { actor: by.actor, principal: by.principal, kind: actor?.kind ?? 'external', handle: actor?.handle ?? by.actor, name: actor?.name ?? by.actor },
      isMentioned: payload.reason === 'mention',
      isSubscribed: payload.subscribed,
      isWatched: payload.reason === 'watch',
      session: payload.engaged,
    }
  }

  /** The agent's session for a notification. A `session` that throws, or names none, gets the default. */
  const sessionOf = (entry: Entry, context: NotifyContext) => {
    const fallback = context.session ?? `thread-${context.thread.id}`
    try {
      const chosen = typeof entry.config.session === 'function' ? entry.config.session(context) : entry.config.session
      return chosen && chosen.length <= 200 ? chosen : fallback
    } catch (error) {
      console.error(`[vboard] agent ${entry.agent.key}'s session threw, so this one goes to ${fallback}:`, describe(error))
      return fallback
    }
  }

  const notificationOf = (context: NotifyContext): AgentNotification => {
    const { event } = context
    const message = event.message!
    const type = event.type as ThreadEvent
    const happened = event.payload as { emoji?: string; set?: Record<string, string>; unset?: string[] }
    const text = type === 'message.posted' || type === 'message.edited' ? readableText(message).split('\n')[0]!.slice(0, 300) : ''
    return {
      reason: context.isMentioned ? 'mention' : context.isSubscribed ? 'subscribed' : 'watch',
      type,
      thread: context.thread.id,
      channel: message.channel,
      message: message.id,
      by: { handle: context.author.handle, name: context.author.name },
      ...(text ? { text } : {}),
      ...(type.startsWith('reaction.') && happened.emoji ? { emoji: happened.emoji } : {}),
      ...(type === 'labels.changed' ? { labels: { set: happened.set ?? {}, unset: happened.unset ?? [] } } : {}),
    }
  }

  async function inboxOf(key: string, session: string): Promise<Inbox> {
    const { state } = await server.session(agentSession(key)).state(inboxReducer)
    return own(state, session) ?? { unread: [], read: 0 }
  }

  /** Wakes an A2 agent's session, unless a wakeup already waits there: the agent reads every notification when it runs. */
  async function wakeA2(entry: Entry, agent: A2Agent, session: string, delivered: number) {
    const target = agent.session(session)
    // With no reducer, `state()` folds the agent's own: A2's AI state.
    const { state } = await (target as unknown as { state(): Promise<{ state: AIState }> }).state()
    const queue: { message: UIMessage; generate: boolean }[] = [...state.inbox.items]
    for (const { command } of state.pendingQueueCommands ?? [])
      if (command.action === 'send') queue.push({ message: command.message, generate: command.generate !== false })
    // A failed turn holds everything behind it: stop it first, so this wakeup runs, or the one already
    // waiting does. Stopping only when no wakeup waits would leave the session stuck behind the failure.
    if (state.active?.phase === 'failed') {
      const [stop] = inputs.stop({ turnId: state.active.turnId })
      await target.append({ ...stop!, id: await idempotentId('vboard.stop', entry.agent.key, session, state.active.turnId) })
    }
    if (queue.some((item) => item.generate && (item.message.metadata as { vboard?: unknown } | undefined)?.vboard)) return
    const { unread } = await inboxOf(entry.agent.key, session)
    if (unread.length === 0) return
    const message: UIMessage = {
      id: await idempotentId('vboard.wake', entry.agent.key, session, String(delivered)),
      role: 'user',
      parts: [{ type: 'text', text: wakeText(unread) }],
      metadata: { vboard: { wake: true } },
    }
    await target.append(...inputs.message(message))
  }

  /**
   * Runs `wake` a few times, then gives up and says so in the thread, as the board: a dead letter would
   * stop the session's notifications for good, and a silent one would leave people waiting.
   */
  async function attempt(
    ctx: { attempt: number; event: { id: string }; session: { append: HandlerContext<typeof agentsContract.events>['session']['append'] } },
    entry: Entry,
    where: { thread: string; root: number },
    wake: () => Promise<void>,
  ) {
    try {
      await wake()
    } catch (error) {
      if (ctx.attempt < RUN_ATTEMPTS) throw error
      console.error(`[vboard] agent ${entry.agent.key} gave up on ${ctx.event.id} after ${ctx.attempt} tries:`, describe(error))
      const reason = describe(error).split('\n')[0]!.slice(0, 200)
      try {
        await bound().notice(entry.agent, where.root, `${entry.agent.name} couldn't start: ${reason}. Reply to try again.`, `gave-up:${ctx.event.id}`)
      } catch (failure) {
        console.error(`[vboard] agent ${entry.agent.key}'s notice failed too:`, describe(failure))
      }
      await ctx.session.append(`failed:${ctx.event.id}`, { type: 'agent.failed', payload: { notified: ctx.event.id, thread: where.thread, error: describe(error) } })
    }
  }

  const server = createServer({
    contract: agentsContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      // On the session's lane: its notifications land, and wake it, one at a time.
      'agent.notified': {
        lane: ({ event }) => `session:${event.payload.session}`,
        handler: async (ctx) => {
          // An agent removed from config since it was notified has nothing left to do.
          const entry = byKey.get(ctx.session.id.slice('agent:'.length))
          if (!entry) return
          const { payload } = ctx.event
          const context = contextOf(payload)
          await attempt(ctx, entry, { thread: payload.thread, root: payload.root.id }, async () => {
            if (entry.config.notify && !(await entry.config.notify(context))) return
            const notification = notificationOf(context)
            const [delivered] = await ctx.session.append(`delivered:${ctx.event.id}`, {
              type: 'agent.delivered',
              payload: { session: payload.session, notification },
            })
            const index = delivered!.index
            const { run } = entry.config
            if (isA2Agent(run)) await wakeA2(entry, run, payload.session, index)
            else if (run)
              await run({
                session: payload.session,
                board: bound().client(entry.agent, { key: `${payload.session}:${index}`, session: payload.session }),
                notification: notificationView({ index, createdAt: new Date(delivered!.createdAt).getTime(), notification }),
                attempt: ctx.attempt,
              })
          })
        },
      },
    },
  })

  async function dispatch(ctx: HandlerContext<BoardEvents>) {
    const event = ctx.event as BoardEvent
    if (!(THREAD_EVENTS as readonly string[]).includes(event.type)) return
    const by = (event.payload as { by: { actor: string } }).by.actor
    // The board's own watchers, clients, and notices never wake an agent: no loops.
    if (isBoardActor(by) && agentKeyOf(by) === null) return
    const through = event.index - 1
    const [{ state: messages }, { state: actors }, { state: subscriptions }] = await Promise.all([
      ctx.session.state(messagesReducer, { through }),
      ctx.session.state(actorsReducer, { through }),
      ctx.session.state(subscriptionsReducer, { through }),
    ])
    const { before, after } = foldEvent(messages, actors, event)
    if (!after || (after.deleted && event.type !== 'message.deleted')) return
    const root = after.re === null ? after : messages.byId[after.re]
    if (!root) return
    const known = options.mentionable(actors)
    let view: BoardEventView | undefined
    for (const entry of entries) {
      const { agent } = entry
      if (by === agent.id) continue
      // A post mentions whoever it names; an edit, only those it adds.
      const mentioned =
        (event.type === 'message.posted' || event.type === 'message.edited') &&
        after.mentions.includes(agent.id) &&
        !(event.type === 'message.edited' && before?.mentions.includes(agent.id))
      const subscription = subscriptionOf(subscriptions, after.thread, agent.id)
      const subscribed = subscription?.subscribed === true
      let watched = false
      if (!mentioned && !subscribed && entry.watch) {
        const match = compileFilter(entry.watch.filters, { me: agent.id, actors: known, messages, access: FULL_ACCESS })
        watched = entry.watch.criteria ? match(before) || match(after) : true
      }
      if (!mentioned && !subscribed && !watched) continue
      view ??= eventView(event, after, known, OWN_CODE)
      const recorded = {
        root: { id: root.id, labels: { ...root.labels } },
        event: view,
        reason: mentioned ? 'mention' : subscribed ? 'subscribed' : 'watch',
        subscribed,
        engaged: subscription?.session ?? null,
      } as const
      await server.session(agentSession(agent.key)).append({
        type: 'agent.notified',
        id: await idempotentId('vboard-agent', agent.key, event.id),
        payload: { thread: after.thread, ...recorded, session: sessionOf(entry, contextOf(recorded)) },
      })
    }
  }

  const lane = ({ event }: { event: { payload: unknown } }) => `thread:${(event.payload as { thread: string }).thread}`

  return {
    server,
    keys: entries.map(({ agent }) => agent.key),
    /** The A2 agents the board runs, for its scheduler to serve. */
    a2Agents: entries.flatMap(({ config }) => (isA2Agent(config.run) ? [config.run] : [])),
    /** Board-contract handlers, on the per-thread lanes sync and watchers use. */
    boardHandlers: entries.length > 0 ? Object.fromEntries(THREAD_EVENTS.map((type) => [type, { lane, handler: dispatch }])) : undefined,
    /** A session's unread notifications, oldest first. */
    async notifications(key: string, session: string): Promise<NotificationView[]> {
      return (await inboxOf(key, session)).unread.map(notificationView)
    },
    /** Marks a session's notifications read through `through`. */
    async read(key: string, session: string, through: number) {
      await server.session(agentSession(key)).append({ type: 'agent.read', payload: { session, through } })
    },
    bind(next: AgentsBinding) {
      binding = next
      for (const entry of entries)
        if (isA2Agent(entry.config.run))
          RUNNING_AGENTS.set(entry.config.run.contract.name, {
            contract: entry.config.run.contract,
            client: (clientOptions) => next.client(entry.agent, clientOptions),
          })
    },
  }
}
