/**
 * sync.ts — mirror Board events into the receipt chain.
 *
 * The mechanism the package supports across processes is the handle's
 * event feed: `events({ after })` replays from a cursor, then follows
 * live. The sync is an explicit, bounded pass: read from the stored
 * cursor until the feed goes quiet (1.5 s idle, 20 s cap), receipt each
 * task-lifecycle event once (dedupe by board cursor), and store the new
 * cursor. The agent CLI runs a sync after every board write, so a single
 * CLI call lands both the board act and its receipt.
 *
 * Mapping: task.created → task.posted, task.claimed → task.claimed,
 * task.completed → task.completed, task.failed → task.failed,
 * task.released → task.released. Plain message events are not receipted:
 * a task's creation is its posting.
 */
import type { Board, BoardEventView } from '@vercel/board'
import { appendReceipt, loadChain, type Receipt } from './chain.ts'
import { findByName, findTaskByBoardId } from './identity.ts'
import { readJson, writeJson } from './store.ts'
import { BOARD_NAME } from './board.ts'

const EVENT_TO_ACTION: Record<string, string> = {
  'task.created': 'task.posted',
  'task.claimed': 'task.claimed',
  'task.completed': 'task.completed',
  'task.failed': 'task.failed',
  'task.released': 'task.released',
}

interface SyncState {
  lastCursor: string | null
  receiptedCursors: string[]
}

const SYNC_FILE = 'sync-state.json'

export function loadSyncState(): SyncState {
  return readJson<SyncState>(SYNC_FILE, { lastCursor: null, receiptedCursors: [] })
}

function saveSyncState(state: SyncState): void {
  writeJson(SYNC_FILE, state)
}

function cursorNum(cursor: string): number {
  const n = Number(cursor)
  return Number.isFinite(n) ? n : 0
}

/** Collect board events: from `after`, or the newest `last` when genesis. */
async function collectEvents(team: Board, after: string | null, genesis: boolean): Promise<BoardEventView[]> {
  const controller = new AbortController()
  const out: BoardEventView[] = []
  let idle: ReturnType<typeof setTimeout> | undefined
  const armIdle = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), 1500)
  }
  const hard = setTimeout(() => controller.abort(), 20000)
  armIdle()
  try {
    // `last` is capped at 100 by the board's own route validation
    // (EVENTS_LAST_MAX). The genesis pass reads the newest 100; this
    // layer creates its board and syncs after every write, so a first
    // sync never faces a longer unreceipted history.
    const query = genesis || !after ? { last: 100 } : { after }
    for await (const event of team.events(query, { signal: controller.signal })) {
      out.push(event)
      armIdle()
      if (out.length >= 1000) break
    }
  } catch (err) {
    // Abort is the normal end of a bounded pass. Any other failure is
    // reported, not hidden: a sync that read nothing says why.
    if (!controller.signal.aborted) {
      console.error(`sync: event feed failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  } finally {
    if (idle) clearTimeout(idle)
    clearTimeout(hard)
    controller.abort()
  }
  return out
}

export interface SyncResult {
  eventsSeen: number
  receiptsAppended: number
  receipts: Receipt[]
  lastCursor: string | null
}

/** One bounded sync pass over the board's feed. */
export async function syncBoard(team: Board): Promise<SyncResult> {
  const state = loadSyncState()
  const genesis = state.lastCursor === null
  const events = await collectEvents(team, state.lastCursor, genesis)
  const ordered = [...events].sort((a, b) => cursorNum(a.cursor) - cursorNum(b.cursor))
  const receipted = new Set(state.receiptedCursors)
  const appended: Receipt[] = []
  let lastCursor = state.lastCursor

  for (const event of ordered) {
    if (cursorNum(event.cursor) > cursorNum(lastCursor ?? '0')) lastCursor = event.cursor
    const action = EVENT_TO_ACTION[event.type]
    if (!action || receipted.has(event.cursor)) continue
    const message = event.message ?? undefined
    const taskId = message?.id
    if (!taskId) continue
    const taskIdentity = findTaskByBoardId(BOARD_NAME, taskId)
    const authorName: string | undefined =
      (event as { actor?: { name?: string } }).actor?.name ?? message?.author?.name ?? undefined
    const actor = authorName ? findByName(authorName) : undefined
    const receipt = await appendReceipt(actor?.uuid ?? null, action, {
      source: 'board-sync',
      board: BOARD_NAME,
      boardCursor: event.cursor,
      boardEvent: event.type,
      boardTaskId: taskId,
      taskUuid: taskIdentity?.uuid ?? null,
      channel: message?.channel ?? null,
      actorProfile: authorName ?? null,
      result: message?.task?.result ?? null,
    })
    receipted.add(event.cursor)
    appended.push(receipt)
  }

  saveSyncState({ lastCursor, receiptedCursors: [...receipted] })
  return { eventsSeen: ordered.length, receiptsAppended: appended.length, receipts: appended, lastCursor }
}

/** Receipts in the chain that carry a board task's uuid (for escrow's
 * release check: the claim and the completion must both be on the chain). */
export function chainHas(taskUuid: string, action: string): boolean {
  return loadChain().some((r) => r.action === action && (r.payload as { taskUuid?: string }).taskUuid === taskUuid)
}
