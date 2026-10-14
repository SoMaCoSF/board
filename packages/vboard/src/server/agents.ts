import { idempotentId } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Server, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { BoardEventView } from '../api/routes.ts'
import type { BoardClient } from '../client/client.ts'
import { agentSession, agentsContract, type BoardEvent, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, messagesReducer, subscriptionsReducer, type ActorsState } from '../contract/reducers.ts'
import { agentKeyOf, isBoardActor, type ActorKind } from '../contract/schemas.ts'
import type { AgentIdentity, DeclaredAgent, DeclaredAgents } from './actors.ts'
import { eventView, foldEvent } from './feed.ts'

/** What `notify` decides on: a board event that mentions an agent, or is new in a thread it follows. */
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
  /** The message mentions this agent. */
  isMentioned: boolean
  /** The agent followed the thread before this message. */
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
  message: number
  reason: 'mention' | 'reply'
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
   * Whether a notification wakes the agent. The default wakes it when it's mentioned or the
   * message is new in a thread it follows. The board's own watchers and clients never wake one.
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

  const server = createServer({
    contract: agentsContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      'agent.notified': {
        lane: ({ event }) => `thread:${event.payload.thread}`,
        handler: async (ctx) => {
          // An agent removed from config since it was notified has nothing left to do.
          const entry = byKey.get(ctx.session.id.slice('agent:'.length))
          if (!entry) return
          const { payload } = ctx.event
          const event = payload.event as BoardEventView
          const message = event.message!
          const actor = event.actor
          const context: NotifyContext = {
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
          try {
            if (!(await (entry.config.notify ?? defaultNotify)(context))) return
            const session = typeof entry.config.session === 'function' ? entry.config.session(context) : (entry.config.session ?? `thread-${payload.root.id}`)
            await runtimeOf(entry).wake({
              id: ctx.event.id,
              session,
              thread: payload.root.id,
              channel: message.channel,
              message: message.id,
              reason: payload.reason,
              by: { handle: context.author.handle, name: context.author.name },
            })
          } catch (error) {
            // A dead letter would stop this agent on the thread for good: a few tries, then move on.
            if (ctx.attempt < RUN_ATTEMPTS) throw error
            console.error(`[vboard] agent ${entry.agent.key} gave up on event #${event.index} after ${ctx.attempt} tries:`, describe(error))
            await ctx.session.append(`failed:${ctx.event.id}`, {
              type: 'agent.failed',
              payload: { notified: ctx.event.id, thread: payload.thread, error: describe(error) },
            })
          }
        },
      },
    },
  })

  async function dispatch(ctx: HandlerContext<BoardEvents>) {
    const event = ctx.event as BoardEvent
    if (event.type !== 'message.posted' && event.type !== 'message.edited') return
    const by = event.payload.by.actor
    // The board's own watchers, clients, and notices never wake an agent: no loops.
    if (isBoardActor(by) && agentKeyOf(by) === null) return
    const through = event.index - 1
    const [{ state: messages }, { state: actors }, { state: subscriptions }] = await Promise.all([
      ctx.session.state(messagesReducer, { through }),
      ctx.session.state(actorsReducer, { through }),
      ctx.session.state(subscriptionsReducer, { through }),
    ])
    const { before, after } = foldEvent(messages, actors, event)
    if (!after || after.deleted) return
    const root = after.re === null ? after : messages.byId[after.re]
    if (!root) return
    let view: BoardEventView | undefined
    for (const { agent } of running) {
      if (by === agent.id) continue
      // An edit notifies only for a mention it adds; a reply in a followed thread, only when it's new.
      const mentioned = after.mentions.includes(agent.id) && !(event.type === 'message.edited' && before?.mentions.includes(agent.id))
      const subscribed = subscriptions[after.thread]?.[agent.id]?.subscribed === true
      if (!mentioned && !(subscribed && event.type === 'message.posted')) continue
      view ??= eventView(event, after, options.mentionable(actors))
      await server.session(agentSession(agent.key)).append({
        type: 'agent.notified',
        id: await idempotentId('vboard-agent', agent.key, event.id),
        payload: {
          thread: after.thread,
          reason: mentioned ? 'mention' : 'reply',
          root: { id: root.id, labels: { ...root.labels } },
          event: view,
          subscribed,
        },
      })
    }
  }

  const lane = ({ event }: { event: { payload: unknown } }) => `thread:${(event.payload as { thread: string }).thread}`

  return {
    server,
    keys: running.map(({ agent }) => agent.key),
    /** Board-contract handlers, on the per-thread lanes sync and watchers use. */
    boardHandlers: running.length > 0 ? { 'message.posted': { lane, handler: dispatch }, 'message.edited': { lane, handler: dispatch } } : undefined,
    /** Each agent's own A2 servers, built now so the board's scheduler can serve them. */
    servers: () => running.flatMap((entry) => runtimeOf(entry).servers),
    bind(binding: { host: (agent: DeclaredAgent) => AgentHost }) {
      host = binding.host
    },
  }
}
