/**
 * chain.ts — the hash-linked receipt chain.
 *
 * Append-only, one JSON receipt per line in chain.jsonl. Each receipt:
 *   { index, uuid, prev_hash, hash, actor_uuid, action, payload, ts }
 * hash = sha256(prev_hash | actor_uuid | action | canonical(payload) | ts)
 * The genesis receipt's prev_hash is 64 zeros. A walk from any receipt
 * reconstructs who acted, under what ceiling, on what decision — claims,
 * completions, routing decisions, escrow moves, and refusals are links in
 * this one chain, not side logs.
 *
 * Receipt uuids are PROVISIONAL uuid5 over (index, hash) — see uuid.ts.
 */
import { canonical, sha256, uuid5 } from './uuid.ts'
import { appendLine, nowIso, readLines } from './store.ts'
import { sinkReceipt } from './supabase.ts'

export const GENESIS_PREV = '0'.repeat(64)
const CHAIN = 'chain.jsonl'

export interface Receipt {
  index: number
  uuid: string
  prev_hash: string
  hash: string
  actor_uuid: string | null
  action: string
  payload: Record<string, unknown>
  ts: string
}

export function receiptHash(prev_hash: string, actor_uuid: string | null, action: string, payload: Record<string, unknown>, ts: string): string {
  return sha256([prev_hash, actor_uuid ?? '', action, canonical(payload), ts].join('|'))
}

export function loadChain(): Receipt[] {
  return readLines(CHAIN).map((l) => JSON.parse(l) as Receipt)
}

export async function appendReceipt(
  actor_uuid: string | null,
  action: string,
  payload: Record<string, unknown>,
): Promise<Receipt> {
  const chain = loadChain()
  const prev = chain.length > 0 ? chain[chain.length - 1] : undefined
  const index = prev ? prev.index + 1 : 0
  const prev_hash = prev ? prev.hash : GENESIS_PREV
  const ts = nowIso()
  const hash = receiptHash(prev_hash, actor_uuid, action, payload, ts)
  const receipt: Receipt = {
    index,
    uuid: uuid5(`imbuuid:receipt:${index}:${hash}`),
    prev_hash,
    hash,
    actor_uuid,
    action,
    payload,
    ts,
  }
  appendLine(CHAIN, JSON.stringify(receipt))
  await sinkReceipt(receipt)
  return receipt
}

export interface VerifyResult {
  ok: boolean
  length: number
  brokenAt?: number
  reason?: string
  headHash?: string
}

/** Recompute the whole chain: indexes in order, links intact, hashes true. */
export function verifyChain(): VerifyResult {
  const chain = loadChain()
  let prev_hash = GENESIS_PREV
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i]
    if (r.index !== i) return { ok: false, length: chain.length, brokenAt: i, reason: `index ${r.index} out of order` }
    if (r.prev_hash !== prev_hash) return { ok: false, length: chain.length, brokenAt: i, reason: 'prev_hash does not match the prior receipt hash' }
    const expect = receiptHash(r.prev_hash, r.actor_uuid, r.action, r.payload, r.ts)
    if (r.hash !== expect) return { ok: false, length: chain.length, brokenAt: i, reason: 'hash does not recompute from the receipt body' }
    prev_hash = r.hash
  }
  return { ok: true, length: chain.length, headHash: prev_hash }
}
