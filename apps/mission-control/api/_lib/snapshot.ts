import { board } from '@vercel/board'
import type { ActorView, BoardEventView, MessageView } from '@vercel/board'
import type { ActivitySnapshot, McActor, McDecision, McEvent, McTask } from './types.ts'

type BoardHandle = ReturnType<typeof board>

const EVENT_LIMIT = 40
const TASK_LIMIT = 50

/** `claude via julian`, from an actor view: its name, then who it acts through. */
export function actorDisplay(actor: ActorView | null | undefined): string | null {
  if (!actor) return null
  return actor.via ? `${actor.name} via ${actor.via.name}` : actor.name
}

function truncate(text: string, at = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > at ? `${flat.slice(0, at - 1)}…` : flat
}

/** A `decision@1` block's data, when a message carries one: the routing receipt Jev writes. */
function decisionOf(message: MessageView | null | undefined): McDecision | undefined {
  const block = message?.blocks?.find((b) => b.schema === 'decision')
  if (!block) return undefined
  const data = block.data ?? {}
  if (typeof data.choice !== 'string') return undefined
  return {
    choice: data.choice,
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    backend: typeof data.backend === 'string' ? data.backend : null,
  }
}

function summarize(event: BoardEventView, actorName: string | null, taskText: string | null): string {
  const who = actorName ?? 'the board'
  const message = event.message ?? null
  switch (event.type) {
    case 'message.posted':
      if (!message) return `${who} posted a message`
      return message.re
        ? `${who} replied: ${truncate(message.text)}`
        : `${who} posted: ${truncate(message.text)}`
    case 'message.edited':
      return `${who} edited a message`
    case 'message.deleted':
      return `${who} deleted a message`
    case 'task.created':
      return `task #${message?.id ?? ''} created${taskText ? `: ${truncate(taskText, 60)}` : ''}`
    case 'task.claimed':
      return `${who} claimed #${message?.id ?? ''}${taskText ? ` (${truncate(taskText, 50)})` : ''}`
    case 'task.renewed':
      return `${who} renewed the claim on #${message?.id ?? ''}`
    case 'task.released':
      return `${who} released #${message?.id ?? ''}`
    case 'task.expired':
      return `the claim on #${message?.id ?? ''} expired`
    case 'task.completed':
      return `${who} completed #${message?.id ?? ''}`
    case 'task.failed':
      return `${who} failed #${message?.id ?? ''}`
    case 'task.blocked':
      return `${who} blocked #${message?.id ?? ''}`
    case 'task.unblocked':
      return `${who} unblocked #${message?.id ?? ''}`
    case 'task.canceled':
      return `${who} canceled #${message?.id ?? ''}`
    case 'task.reopened':
      return `${who} reopened #${message?.id ?? ''}`
    case 'task.ready':
      return `#${message?.id ?? ''} is ready`
    case 'task.assigned':
      return `${who} assigned #${message?.id ?? ''}`
    case 'actor.seen':
      return `${who} was seen`
    default:
      return event.type
  }
}

/** The feed's newest events, once: `events({ last })` sends them first, then follows live. */
async function recentEvents(client: BoardHandle): Promise<BoardEventView[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  const out: BoardEventView[] = []
  try {
    for await (const event of client.events({ last: EVENT_LIMIT }, { signal: controller.signal })) {
      out.push(event)
      if (out.length >= EVENT_LIMIT) break
    }
  } catch {
    // A board that can't read its feed across channels answers 501: the snapshot
    // then carries tasks and channels without a feed, and the page says so.
    return []
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return out
}

/**
 * One snapshot of a board's agent activity, from the handle's own reads:
 * `channels`, `tasks.list` (latest first), `actors`, and the feed's newest events.
 */
export async function buildSnapshot(client: BoardHandle): Promise<ActivitySnapshot> {
  const [discovery, channelPage, actorList, taskPage, events] = await Promise.all([
    client.discovery().catch(() => null),
    client.channels({ limit: 500 }),
    client.actors(),
    client.tasks.list({ state: 'all', latest: true, limit: TASK_LIMIT }),
    recentEvents(client),
  ])

  const byId = new Map<string, string>()
  for (const actor of actorList) {
    byId.set(actor.id, actor.via ? `${actor.name} via ${actor.via.name}` : actor.name)
  }
  const displayOf = (id: string | null | undefined): string | null =>
    id ? (byId.get(id) ?? id) : null

  const tasks: McTask[] = []
  const claimCount = new Map<string, number>()
  for (const summary of taskPage.tasks) {
    const root = summary.message
    const task = root.task
    if (!task) continue
    if (task.claim) claimCount.set(task.claim.actor, (claimCount.get(task.claim.actor) ?? 0) + 1)
    tasks.push({
      id: root.id,
      channel: root.channel,
      text: root.text,
      state: task.state,
      holder: displayOf(task.claim?.actor),
      leaseUntil: task.claim?.until ?? null,
      assignedFor: displayOf(task.for),
      needs: task.needs,
      labels: root.labels ?? {},
      replies: summary.replies,
      lastActivityAt: summary.last?.createdAt ?? root.createdAt ?? null,
      outcome: task.result ?? task.reason ?? null,
    })
  }

  const mcEvents: McEvent[] = events.map((event) => {
    const message = event.message ?? null
    const actorName = actorDisplay(message?.author) ?? null
    const decision = decisionOf(message)
    return {
      cursor: event.cursor,
      type: event.type,
      at: typeof event.createdAt === 'string' ? event.createdAt : new Date(event.createdAt).toISOString(),
      channel: message?.channel ?? null,
      actor: actorName,
      summary: summarize(event, actorName, message?.text ?? null),
      ...(decision ? { decision } : {}),
    }
  })

  const lastActive = new Map<string, string>()
  for (const event of mcEvents) {
    if (event.actor && !lastActive.has(event.actor)) lastActive.set(event.actor, event.at)
  }

  const actors: McActor[] = actorList.map((actor) => {
    const display = actor.via ? `${actor.name} via ${actor.via.name}` : actor.name
    return {
      id: actor.id,
      name: actor.name,
      handle: actor.handle,
      kind: actor.kind,
      via: actor.via?.name ?? null,
      platform: actor.platform ?? null,
      verified: actor.verified === true,
      lastActiveAt: lastActive.get(display) ?? null,
      activeClaims: claimCount.get(actor.id) ?? 0,
    }
  })

  const open = tasks.filter((t) => ['waiting', 'ready', 'claimed', 'blocked'].includes(t.state))
  return {
    mode: 'live',
    fallbackReason: null,
    generatedAt: new Date().toISOString(),
    boardName: discovery?.name ?? null,
    channels: channelPage.channels.map((c) => ({
      path: c.path,
      messages: c.messages ?? 0,
      threads: c.threads ?? 0,
    })),
    tasks,
    actors,
    events: mcEvents,
    counts: {
      channels: channelPage.channels.length,
      openTasks: open.length,
      claimed: tasks.filter((t) => t.state === 'claimed').length,
      actors: actors.length,
    },
  }
}

/** A handle on the board this deployment acts on, per `board()`'s own resolution. */
export function liveClient(): BoardHandle {
  return board()
}
