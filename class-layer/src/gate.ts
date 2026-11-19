/**
 * gate.ts — the ceiling check, run before an act executes.
 *
 * The registry resolves the actor's committed ceiling at act time. An act
 * inside the ceiling proceeds. An act outside it does not execute, and the
 * refusal is itself receipted (action `ceiling.refused`, the clause named)
 * — the system checks the Identity's rights, and writes down the answer
 * either way. This is the explainer's worked refusal (SOM-DOC-10866)
 * as code: a pack under READ + CLASSIFY reaches a SEND step; the check
 * stops it; the stop is on the chain.
 */
import { appendReceipt } from './chain.ts'
import { ceilingAdmits, findByName, type Identity } from './identity.ts'

export class CeilingRefused extends Error {
  receiptUuid: string
  constructor(actor: Identity, actionClass: string, receiptUuid: string) {
    super(`ceiling refusal: ${actor.name} may not perform ${actionClass} — ceiling [${actor.ceiling.join(', ')}] does not include ${actionClass}`)
    this.receiptUuid = receiptUuid
  }
}

export function actorOrThrow(name: string): Identity {
  const actor = findByName(name)
  if (!actor) throw new Error(`actor not registered: ${name} (register it first: board-agent register ${name} --ceiling ...)`)
  if (actor.type_code !== 1) throw new Error(`${name} is not an actor identity`)
  return actor
}

/**
 * Check the actor's ceiling for the action class. On refusal: append the
 * ceiling.refused receipt and throw CeilingRefused. On success: returns
 * the actor (the caller proceeds; lifecycle receipts are written by the
 * board sync or the operation itself).
 */
export async function gate(actorName: string, actionClass: string, context: Record<string, unknown> = {}): Promise<Identity> {
  const actor = actorOrThrow(actorName)
  const cls = actionClass.toUpperCase()
  if (ceilingAdmits(actor, cls)) return actor
  const receipt = await appendReceipt(actor.uuid, 'ceiling.refused', {
    actor: actor.name,
    attempted: cls,
    clause: `ceiling of ${actor.name} [${actor.ceiling.join(', ')}] does not include ${cls}`,
    ceiling: actor.ceiling,
    ...context,
  })
  throw new CeilingRefused(actor, cls, receipt.uuid)
}
