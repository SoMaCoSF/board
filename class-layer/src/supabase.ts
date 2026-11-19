/**
 * supabase.ts — the class layer's Supabase sink.
 *
 * When SUPABASE_URL and SUPABASE_SECRET_KEY are set in the environment,
 * every Identity and receipt also lands in the class-layer tables of the
 * Supabase project (schema: supabase/migrations/0001_class_layer.sql at
 * the repo root — identities, receipts, escrow_accounts, escrow_holds).
 * Keys come from the environment only; no key is ever written to a file.
 *
 * When the environment is absent the sink is off and every caller runs
 * local-only — and says so. A sink failure never breaks a local write:
 * the local chain is the record; the sink is a mirror. Failures are
 * reported on stderr, not hidden.
 */
import type { Identity } from './identity.ts'

export interface ReceiptLike {
  uuid: string
  prev_hash: string
  hash: string
  actor_uuid: string | null
  action: string
  payload: Record<string, unknown>
  ts: string
}

export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY)
}

export function sinkState(): string {
  return supabaseConfigured()
    ? `Supabase sink configured (${process.env.SUPABASE_URL})`
    : 'local-only — SUPABASE_URL / SUPABASE_SECRET_KEY not set in the environment; no Supabase writes made'
}

async function post(table: string, rows: Record<string, unknown>[], upsert: boolean): Promise<void> {
  if (!supabaseConfigured()) return
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY as string,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Prefer: upsert ? 'resolution=merge-duplicates' : 'return=minimal',
      },
      body: JSON.stringify(rows),
    })
    if (!res.ok) {
      console.error(`supabase sink: POST ${table} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
  } catch (err) {
    console.error(`supabase sink: POST ${table} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function sinkIdentity(identity: Identity): Promise<void> {
  await post(
    'identities',
    [
      {
        uuid: identity.uuid,
        type_code: identity.type_code,
        ceiling: { classes: identity.ceiling, name: identity.name },
        profile_commitment: identity.profile_commitment,
        created_at: identity.created_at,
      },
    ],
    true,
  )
}

export async function sinkReceipt(receipt: ReceiptLike): Promise<void> {
  await post(
    'receipts',
    [
      {
        uuid: receipt.uuid,
        prev_hash: receipt.prev_hash,
        hash: receipt.hash,
        actor_uuid: receipt.actor_uuid,
        action: receipt.action,
        payload: receipt.payload,
        created_at: receipt.ts,
      },
    ],
    true,
  )
}

export async function sinkEscrowAccount(taskUuid: string, balance: number, state: string): Promise<void> {
  await post('escrow_accounts', [{ task_uuid: taskUuid, balance, state }], true)
}

export async function sinkEscrowHold(hold: {
  uuid: string
  task_uuid: string
  amount: number
  state: string
  release_receipt_uuid: string | null
}): Promise<void> {
  await post(
    'escrow_holds',
    [
      {
        uuid: hold.uuid,
        task_uuid: hold.task_uuid,
        amount: hold.amount,
        state: hold.state,
        release_receipt_uuid: hold.release_receipt_uuid,
      },
    ],
    true,
  )
}
