import { idempotentId } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Server, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { BoardEventView } from '../api/routes.ts'
import type { BoardClient } from '../client/client.ts'
import { agentSession, agentsContract, type BoardEvent, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, messagesReducer, subscriptionOf, subscriptionsReducer, type ActorsState } from '../contract/reducers.ts'
import { agentKeyOf, isBoardActor, type ActorKind } from '../contract/schemas.ts'
import type { AgentIdentity, DeclaredAgent, DeclaredAgents } from './actors.ts'
import { eventView, foldEvent } from './feed.ts'

/** What reaches an agent from a thread it follows: anything that happens to its messages. */
export const THREAD_EVENTS = ['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed'] as const
export type ThreadEvent = (typeof THREAD_EVENTS)[number]

/** What `notify` decides on: a board event that mentions an agent, or happens in a thread it follows. */
export type NotifyContext = {
  /** The board event, as `vb tail --json` prints it. */
  event: BoardEventView
  /** The thread: its root's ID and labels, and its channel. */
  thread: { id: number; channel: string; labels: Record<string, string> }
  /**
   * Who wrote it, as the board verified it: `principal` is the credential (`slack:user:U0456`,
   * `vercel:user:…`). Decide here who may wake an agent that can change things.
   */
  author: { actor: string; principal: string; kind: ActorKind; handle: string; name: string }
  /** A post, or an edit, that mentions this agent. */
  isMentioned: boolean
  /** The agent followed the thread before this event. */
  isSubscribed: boolean
}

/** A notification `notify` let through, for the agent's runtime to wake it with. */
export type Notification = {
  /** Unique per notification and stable across retries. */
  id: string
  /** The agent's session it lands in: `thread-<root>` unless `session` says otherwise. */
  session: string
  thread: number
  channel: string
  /** The message it concerns. */
  message: number
  /** `mention`: it mentions the agent. `subscribed`: it happened in a thread the agent follows. */
  reason: 'mention' | 'subscribed'
  /** What happened, as the board event's type. */
  type: ThreadEvent
  /** For a reaction: the emoji's short name. */
  emoji?: string
  /** For a label change: what was set and unset. */
  labels?: { set: Record<string, string>; unset: string[] }
  by: { handle: string; name: string }
}

/** What the board gives a runtime: the agent's identity, its store, and how to write. */
export type AgentHost = {
  key: string
  name: string
  store: A2Store | undefined
  scheduler: A2Scheduler | undefined
  /** A client writing as the agent; a `key` makes its posts idempotent, `session` is recorded on its writes. */
  client(options: { key?: string; session?: string }): BoardClient
  /**
   * The board's own reply in a thread, never the agent's: `<name> couldn't finish: …`.
   * `key` makes it idempotent. It never wakes an agent.
   */
  notice(thread: number, text: string, key: string): Promise<void>
  /** Wakes the agent for `notification` again, in turn with its session's others. `key` makes it idempotent. */
  retry(notification: Notification, key: string): Promise<void>
}

/** How the board runs an agent: `agent()` from `vboard/agents` builds one. */
export type AgentRuntime = {
  /** The A2 servers that run it, which share the board's scheduler. */
  servers: readonly A2Server<never>[]
  /** Wakes the agent for a notification. Called at least once per notification. */
  wake(notification: Notification): Promise<void>
}

/** What `board({ agents })` takes for each agent: who it is, and, for one the board runs, how. */
export type AgentConfig = AgentIdentity & {
  /**
   * Whether a notification wakes the agent. The default wakes it when it's mentioned, and for anything
   * that happens in a thread it follows. The board's own watchers and clients never wake one.
   */
  notify?: (context: NotifyContext) => boolean | Promise<boolean>
  /** Which of the agent's sessions a notification lands in: one per thread (`thread-<root>`) by default. */
  session?: string | ((context: NotifyContext) => string)
  /** Set by `agent()` from `vboard/agents`: the board runs this agent. */
  run?: (host: AgentHost) => AgentRuntime
}

const RUN_ATTEMPTS = 5
const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

const defaultNotify = ({ isMentioned, isSubscribed }: NotifyContext) => isMentioned || isSubscribed

/**
 * The agents the board runs. A board-contract handler finds each message that
 * mentions one, or is new in a thread it follows, and appends it to that agent's
 * session; there, on the thread's lane, `notify` decides and the runtime wakes it.
 */
export function createAgents(options: {
  config: Record<string, AgentConfig>
  declared: DeclaredAgents
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
  mentionable: (actors: ActorsState) => ActorsState
}) {
  type Running = { agent: DeclaredAgent; config: AgentConfig; runtime: AgentRuntime | null }
  const running: Running[] = []
  for (const [key, config] of Object.entries(options.config))
    if (config.run) running.push({ agent: options.declared.get(key)!, config, runtime: null })
  const byKey = new Map(running.map((entry) => [entry.agent.key, entry]))

  let host: ((agent: DeclaredAgent) => AgentHost) | null = null
  const runtimeOf = (entry: Running): AgentRuntime => {
    if (!host) throw new Error('agents used before the board bound them')
    return (entry.runtime ??= entry.config.run!(host(entry.agent)))
  }

  /** What `notify` and `session` decide on, from what the board recorded. */
  const contextOf = (payload: { root: { id: number; labels: Record<string, string> }; event: unknown; reason: 'mention' | 'subscribed'; subscribed: boolean }): NotifyContext => {
    const event = payload.event as BoardEventView
    const message = event.message!
    const actor = event.actor
    return {
      event,
      thread: { id: payload.root.id, channel: message.channel, labels: payload.root.labels },
      author: {
        actor: message.by.actor,
        principal: message.by.principal,
        kind: actor?.kind ?? message.author?.kind ?? 'external',
        handle: actor?.handle ?? message.author?.handle ?? message.by.actor,
        name: actor?.name ?? message.author?.name ?? message.by.actor,
      },
      isMentioned: payload.reason === 'mention',
      isSubscribed: payload.subscribed,
    }
  }

  /** The agent's session for a notification: its `session`, or one per thread. A `session` that throws gets the default. */
  const sessionOf = (entry: Running, context: NotifyContext) => {
    const fallback = `thread-${context.thread.id}`
    try {
      const chosen = typeof entry.config.session === 'function' ? entry.config.session(context) : entry.config.session
      return chosen && chosen.length <= 200 ? chosen : fallback
    } catch (error) {
      console.error(`[vboard] agent ${entry.agent.key}'s session threw, so this one is ${fallback}:`, describe(error))
      return fallback
    }
  }

  /**
   * Runs `wake` a few times, then gives up and says so in the thread, as the board: a dead letter would
   * stop the session's notifications for good, and a silent one would leave people waiting.
   */
  async function attempt(
    ctx: { attempt: number; event: { id: string }; session: { append: HandlerContext<typeof agentsContract.events>['session']['append'] } },
    entry: Running,
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
        await host!(entry.agent).notice(where.root, `${entry.agent.name} couldn't start: ${reason}. Reply to try again.`, `gave-up:${ctx.event.id}`)
      } catch (failure) {
        console.error(`[vboard] agent ${entry.agent.key}'s notice failed too:`, describe(failure))
      }
      await ctx.session.append(`failed:${ctx.event.id}`, { type: 'agent.failed', payload: { notified: ctx.event.id, thread: where.thread, error: describe(error) } })
    }
  }

  const entryOf = (session: string) => byKey.get(session.slice('agent:'.length))

  const server = createServer({
    contract: agentsContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      // On the agent's session's lane, not the thread's: two threads that share a session would
      // otherwise both edit the wakeup waiting in it, and one notification would be lost.
      'agent.notified': {
        lane: ({ event }) => `session:${event.payload.session}`,
        handler: async (ctx) => {
          // An agent removed from config since it was notified has nothing left to do.
          const entry = entryOf(ctx.session.id)
          if (!entry) return
          const { payload } = ctx.event
          const context = contextOf(payload)
          const message = context.event.message!
          const type = context.event.type as ThreadEvent
          const happened = context.event.payload as { emoji?: string; set?: Record<string, string>; unset?: string[] }
          await attempt(ctx, entry, { thread: payload.thread, root: payload.root.id }, async () => {
            if (!(await (entry.config.notify ?? defaultNotify)(context))) return
            await runtimeOf(entry).wake({
              id: ctx.event.id,
              session: payload.session,
              thread: payload.root.id,
              channel: message.channel,
              message: message.id,
              reason: payload.reason,
              type,
              ...(type.startsWith('reaction.') && happened.emoji ? { emoji: happened.emoji } : {}),
              ...(type === 'labels.changed' ? { labels: { set: happened.set ?? {}, unset: happened.unset ?? [] } } : {}),
              by: { handle: context.author.handle, name: context.author.name },
            })
          })
        },
      },
      'agent.retried': {
        lane: ({ event }) => `session:${event.payload.session}`,
        handler: async (ctx) => {
          const entry = entryOf(ctx.session.id)
          if (!entry) return
          const notification = ctx.event.payload.notification as Notification
          await attempt(ctx, entry, { thread: String(notification.thread), root: notification.thread }, () => runtimeOf(entry).wake(notification))
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
    let view: BoardEventView | undefined
    for (const { agent } of running) {
      if (by === agent.id) continue
      // A post mentions whoever it names; an edit, only those it adds.
      const mentioned =
        (event.type === 'message.posted' || event.type === 'message.edited') &&
        after.mentions.includes(agent.id) &&
        !(event.type === 'message.edited' && before?.mentions.includes(agent.id))
      const subscribed = subscriptionOf(subscriptions, after.thread, agent.id)?.subscribed === true
      if (!mentioned && !subscribed) continue
      view ??= eventView(event, after, options.mentionable(actors))
      const recorded = { root: { id: root.id, labels: { ...root.labels } }, event: view, reason: mentioned ? 'mention' : 'subscribed', subscribed } as const
      await server.session(agentSession(agent.key)).append({
        type: 'agent.notified',
        id: await idempotentId('vboard-agent', agent.key, event.id),
        payload: { thread: after.thread, ...recorded, session: sessionOf(byKey.get(agent.key)!, contextOf(recorded)) },
      })
    }
  }

  const lane = ({ event }: { event: { payload: unknown } }) => `thread:${(event.payload as { thread: string }).thread}`

  return {
    server,
    keys: running.map(({ agent }) => agent.key),
    /** Board-contract handlers, on the per-thread lanes sync and watchers use. */
    boardHandlers: running.length > 0 ? Object.fromEntries(THREAD_EVENTS.map((type) => [type, { lane, handler: dispatch }])) : undefined,
    /** Each agent's own A2 servers, built now so the board's scheduler can serve them. */
    servers: () => running.flatMap((entry) => runtimeOf(entry).servers),
    bind(binding: { host: (agent: DeclaredAgent) => Omit<AgentHost, 'retry'> }) {
      host = (agent) => ({
        ...binding.host(agent),
        retry: async (notification, key) => {
          await server.session(agentSession(agent.key)).append({
            type: 'agent.retried',
            id: await idempotentId('vboard-agent-retry', agent.key, key),
            payload: { session: notification.session, notification },
          })
        },
      })
    },
  }
}
