/**
 * escrow.ts — escrow on test value: hold under a task's Identity,
 * release on a verified completion receipt.
 *
 * A hold binds test value to the task's Identity (escrow_accounts is
 * keyed by the task's uuid). Release fires only when the chain itself
 * verifies the completion: a task.claimed receipt and a task.completed
 * receipt for the task's uuid must both be on the chain. There is no
 * release path that skips that check. The release is a receipt in the
 * same chain as the work. Amounts are test value, labeled as such in
 * every payload.
 */
import { appendReceipt, loadChain } from './chain.ts'
import { uuid5 } from './uuid.ts'
import { nowIso, readJson, writeJson } from './store.ts'
import { sinkEscrowAccount, sinkEscrowHold } from './supabase.ts'
import { chainHas } from './sync.ts'

export interface EscrowAccount {
  task_uuid: string
  balance: number
  state: string
  created_at: string
}

export interface EscrowHold {
  uuid: string
  task_uuid: string
  amount: number
  state: string
  release_receipt_uuid: string | null
  created_at: string
}

interface EscrowFile {
  accounts: EscrowAccount[]
  holds: EscrowHold[]
}

const ESCROW = 'escrow.json'

export function loadEscrow(): EscrowFile {
  return readJson<EscrowFile>(ESCROW, { accounts: [], holds: [] })
}

function saveEscrow(file: EscrowFile): void {
  writeJson(ESCROW, file)
}

export function openHoldFor(taskUuid: string): EscrowHold | undefined {
  return loadEscrow().holds.find((h) => h.task_uuid === taskUuid && h.state === 'held')
}

/** Hold test value under the task's Identity. Caller runs the ESCROW gate. */
export async function holdEscrow(
  actorUuid: string,
  actorName: string,
  taskUuid: string,
  boardTaskId: string,
  amount: number,
): Promise<EscrowHold> {
  const file = loadEscrow()
  let account = file.accounts.find((a) => a.task_uuid === taskUuid)
  if (!account) {
    account = { task_uuid: taskUuid, balance: 0, state: 'held', created_at: nowIso() }
    file.accounts.push(account)
  }
  const hold: EscrowHold = {
    uuid: uuid5(`imbuuid:escrow:${taskUuid}:${file.holds.length}`),
    task_uuid: taskUuid,
    amount,
    state: 'held',
    release_receipt_uuid: null,
    created_at: nowIso(),
  }
  file.holds.push(hold)
  account.balance += amount
  account.state = 'held'
  saveEscrow(file)
  await appendReceipt(actorUuid, 'escrow.held', {
    actor: actorName,
    taskUuid,
    boardTaskId,
    holdUuid: hold.uuid,
    amount,
    testValue: true,
    unit: 'test',
  })
  await sinkEscrowAccount(taskUuid, account.balance, account.state)
  await sinkEscrowHold(hold)
  return hold
}

/**
 * Release the task's open hold against its verified completion receipt.
 * Throws — and writes nothing — when the chain does not carry both the
 * claim and the completion for this task.
 */
export async function releaseEscrow(actorUuid: string, actorName: string, taskUuid: string, boardTaskId: string): Promise<EscrowHold> {
  const hold = openHoldFor(taskUuid)
  if (!hold) throw new Error(`no open escrow hold for task ${boardTaskId}`)
  if (!chainHas(taskUuid, 'task.claimed') || !chainHas(taskUuid, 'task.completed')) {
    throw new Error(`release refused: the chain carries no verified claim + completion for task ${boardTaskId}`)
  }
  const completion = [...loadChain()].reverse().find((r) => r.action === 'task.completed' && r.payload.taskUuid === taskUuid)
  const receipt = await appendReceipt(actorUuid, 'escrow.released', {
    actor: actorName,
    taskUuid,
    boardTaskId,
    holdUuid: hold.uuid,
    amount: hold.amount,
    testValue: true,
    unit: 'test',
    completionReceiptUuid: completion?.uuid ?? null,
  })
  const file = loadEscrow()
  const stored = file.holds.find((h) => h.uuid === hold.uuid)
  if (stored) {
    stored.state = 'released'
    stored.release_receipt_uuid = receipt.uuid
  }
  const account = file.accounts.find((a) => a.task_uuid === taskUuid)
  if (account) {
    account.balance -= hold.amount
    account.state = 'released'
  }
  saveEscrow(file)
  if (account) await sinkEscrowAccount(taskUuid, account.balance, account.state)
  if (stored) await sinkEscrowHold(stored)
  return stored ?? hold
}
