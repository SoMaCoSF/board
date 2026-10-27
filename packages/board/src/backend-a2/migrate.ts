import type { A2Store, Clock, StoredEvent } from 'experimental-a2/server'
import type { z } from 'zod'
import type { BoardEvent } from '../contract/events.ts'
import type { BoardStore } from '../store/types.ts'
import type { BlobStore } from '../server/blob.ts'
import { boardContract, identityContract, registryContract, schedulesContract } from '../contract/contract.ts'
import { BOARD_SESSION } from '../contract/events.ts'
import { IDENTITY_SESSION, REGISTRY_SESSION, SCHEDULES_SESSION } from '../contract/contract.ts'

/** A2 keeps a session under its contract's name, this, and the session's ID. */
const NS = '\u001f'

/**
 * The sessions vboard (0.14 and earlier) kept, by its contract names, and where board keeps
 * each now. Inboxes (raw platform events) and watchers' queues (matches already run) aren't
 * history anyone reads back, so they start empty.
 */
const SESSIONS = [
  { from: 'vboard', contract: boardContract, session: BOARD_SESSION },
  { from: 'vboard-identity', contract: identityContract, session: IDENTITY_SESSION },
  { from: 'vboard-registry', contract: registryContract, session: REGISTRY_SESSION },
  { from: 'vboard-schedules', contract: schedulesContract, session: SCHEDULES_SESSION },
] as const

/** vboard's own principals (`vboard:client`, `vboard:watch:<id>`, …), which board names `board:…`. */
const OWN = /^vboard:(client|local|middleware|schedule|sync|watch)(:|$)/

function renamed(value: unknown): unknown {
  if (typeof value === 'string') return OWN.test(value) ? value.slice(1) : value
  if (Array.isArray(value)) return value.map(renamed)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renamed(inner)]))
  return value
}

/** A clock the migration sets to each event's time before it appends it: pass it to the store too. */
export type ReplayClock = Clock & { set(at: Date | null): void }

/** The store's clock, except while the migration appends an event, when it's that event's time. */
export function replayClock(): ReplayClock {
  let at: Date | null = null
  return {
    now: () => at ?? new Date(),
    set: (next) => {
      at = next
    },
  }
}

export type MigrateFromVboardOptions = {
  /** The board's store, built with `clock`, on the same `keyPrefix` (or file, or database) vboard used. */
  store: BoardStore
  clock: ReplayClock
  /** The board's files, when it keeps them: each message's attachments are copied to where board reads them. */
  blob?: BlobStore
  /** Called after each session, with how many events it copied and how many were there already. */
  onSession?: (report: SessionReport) => void
}

export type SessionReport = { from: string; to: string; copied: number; existing: number; files?: number }

/**
 * Copies what vboard wrote into board's sessions in the same store, in order, keeping each event's
 * ID, index, and time, so thread keys, message IDs, and schedules read as before. It fills board's
 * tables from the copy, so reads see it all at once, and writes no consumer cursors: sync and
 * watchers start after it, so nothing is delivered or woken again. Run it once before the board on board starts
 * writing, with vboard stopped; a run that stopped partway picks up where it left off. It refuses
 * a session board already wrote to, and an event board's contract doesn't accept.
 */
export async function migrateFromVboard(options: MigrateFromVboardOptions): Promise<SessionReport[]> {
  const { store, clock } = options
  const log: A2Store = store.log
  const reports: SessionReport[] = []
  for (const { from, contract, session } of SESSIONS) {
    const source = `${from}${NS}${session}`
    const target = `${contract.name}${NS}${session}`
    const [events, existing] = await Promise.all([log.read(source), log.read(target)])
    for (const [i, event] of existing.entries()) {
      if (events[i]?.id !== event.id)
        throw new Error(`${target} already has events that aren't ${source}'s (index ${event.index}): migrate into an empty store prefix`)
    }
    const schemas = contract.events as Record<string, z.ZodType>
    const pending = events.slice(existing.length).map((event: StoredEvent) => {
      const schema = schemas[event.type]
      if (!schema) throw new Error(`${source} #${event.index}: board has no event type ${event.type}`)
      const payload = renamed(event.payload)
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error(`${source} #${event.index} (${event.type}) doesn't fit board's contract: ${parsed.error.message}`)
      return { id: event.id, type: event.type, payload, index: event.index, createdAt: event.createdAt }
    })
    // One event per append: the store stamps a batch with one time, and each keeps its own.
    try {
      for (const event of pending) {
        clock.set(new Date(event.createdAt))
        const { events: written } = await log.append(target, [{ id: event.id, type: event.type, payload: event.payload }])
        if (written[0]?.index !== event.index) throw new Error(`${target}: ${event.id} landed at index ${written[0]?.index}, not ${event.index}`)
      }
    } finally {
      clock.set(null)
    }
    // A read waits for the tables only through the message it reads, so fill them now, not on demand.
    if (session === BOARD_SESSION) {
      const from = await store.tables.position()
      for (const event of await log.read(target, { afterIndex: from })) await store.tables.apply(event as BoardEvent)
    }
    const files = session === BOARD_SESSION && options.blob ? await copyFiles(options.blob, events) : undefined
    const report = { from: source, to: target, copied: pending.length, existing: existing.length, ...(files !== undefined ? { files } : {}) }
    options.onSession?.(report)
    reports.push(report)
  }
  return reports
}

/** vboard kept a file under `vboard/attachments/<id>`, and its record beside it as `<id>.json`; board, under `board/`. */
async function copyFiles(blob: BlobStore, events: readonly StoredEvent[]): Promise<number> {
  const ids = new Set<string>()
  for (const event of events) {
    const attachments = (event.payload as { attachments?: { id?: unknown }[] } | null)?.attachments
    for (const attachment of attachments ?? []) if (typeof attachment.id === 'string') ids.add(attachment.id)
  }
  let copied = 0
  for (const id of ids) {
    if (await blob.get(`board/attachments/${id}.json`)) continue
    const [data, meta] = await Promise.all([blob.get(`vboard/attachments/${id}`), blob.get(`vboard/attachments/${id}.json`)])
    if (!data || !meta) continue
    await blob.put(`board/attachments/${id}`, await bytes(data.data), data.contentType)
    const record = renamed(JSON.parse(new TextDecoder().decode(await bytes(meta.data))))
    await blob.put(`board/attachments/${id}.json`, new TextEncoder().encode(JSON.stringify(record)), 'application/json')
    copied++
  }
  return copied
}

async function bytes(data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  return data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer())
}
