/**
 * The shapes the mission-control page reads. One snapshot, built server-side from a
 * board handle (`snapshot.ts`) or from the demo fixtures (`fixtures.ts`), and served
 * as JSON by `api/activity.ts`. The page holds no credential and reads nothing else.
 */

export type TaskState =
  | 'waiting'
  | 'ready'
  | 'claimed'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface McChannel {
  path: string
  messages: number
  threads: number
}

export interface McTask {
  /** The thread root's ID, as the board names it (`812`). */
  id: string
  channel: string
  text: string
  state: TaskState
  /** Display name of the actor holding the claim, or null when unclaimed. */
  holder: string | null
  /** When the claim's lease runs out (ISO), or null when unclaimed. */
  leaseUntil: string | null
  /** Display name of the actor the task is assigned to, or null. */
  assignedFor: string | null
  /** IDs of the tasks this one waits for. */
  needs: string[]
  labels: Record<string, string>
  replies: number
  /** ISO time of the thread's last activity. */
  lastActivityAt: string | null
  /** The completion result or the failure / cancel reason, once it ends. */
  outcome: string | null
}

export interface McActor {
  id: string
  name: string
  handle: string
  /** `person`, `profile`, `project`, `external`, as the board names actor kinds. */
  kind: string
  /** Who an actor with a profile acts through (`julian`), or null. */
  via: string | null
  platform: string | null
  verified: boolean
  /** ISO time of the actor's last event on the feed in this snapshot, or null. */
  lastActiveAt: string | null
  /** Tasks this actor currently holds. */
  activeClaims: number
}

/** A routing decision a message carried as a `decision@1` block, as Jev writes one. */
export interface McDecision {
  choice: string
  confidence: number | null
  /** The backend that decided (`jev`, `laya`), as the block names it. */
  backend: string | null
}

export interface McEvent {
  cursor: string
  /** The board's event type (`message.posted`, `task.claimed`, …). */
  type: string
  at: string
  channel: string | null
  /** Display name of the actor the event is by, or null. */
  actor: string | null
  summary: string
  decision?: McDecision
}

export interface ActivitySnapshot {
  /** The snapshot's data source: `live` is a board the handle read; `demo` is the fixture set in `fixtures.ts`. */
  mode: 'live' | 'demo'
  /** Why the demo set is showing when a live board was expected, or null. */
  fallbackReason: string | null
  generatedAt: string
  boardName: string | null
  channels: McChannel[]
  tasks: McTask[]
  actors: McActor[]
  events: McEvent[]
  counts: {
    channels: number
    openTasks: number
    claimed: number
    actors: number
  }
}
