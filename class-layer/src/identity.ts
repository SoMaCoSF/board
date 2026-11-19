/**
 * identity.ts — the imbuuid@1 Identity registry.
 *
 * An Identity record: { uuid, name, type_code, ceiling, profile_commitment,
 * created_at }. The uuid is PROVISIONAL (see uuid.ts for the derivation).
 * The ceiling is the set of action classes the Identity may perform,
 * committed to the Identity at registration: profile_commitment is the
 * sha256 of the canonical { name, type_code, ceiling } body, so a ceiling
 * edited after the fact no longer matches its commitment.
 *
 * Type codes are class-layer-local until the estate codetable revision
 * lands: ACTOR 1, TASK 2, RECEIPT 3, DECISION 4, ESCROW 5.
 */
import { canonical, sha256, uuid5 } from './uuid.ts'
import { nowIso, readJson, writeJson } from './store.ts'
import { sinkIdentity } from './supabase.ts'

export const TYPE_ACTOR = 1
export const TYPE_TASK = 2
export const TYPE_RECEIPT = 3
export const TYPE_DECISION = 4
export const TYPE_ESCROW = 5

export const TYPE_NAMES: Record<number, string> = {
  [TYPE_ACTOR]: 'actor',
  [TYPE_TASK]: 'task',
  [TYPE_RECEIPT]: 'receipt',
  [TYPE_DECISION]: 'decision',
  [TYPE_ESCROW]: 'escrow',
}

/** The action classes a ceiling can hold. A claim or step names one class;
 * the gate checks the actor's committed ceiling for it before the act. */
export const ACTION_CLASSES = [
  'READ',
  'CLASSIFY',
  'WRITE',
  'CLAIM',
  'COMPLETE',
  'EXECUTE',
  'SEND',
  'ROUTE',
  'ESCROW',
  'MANAGE',
] as const
export type ActionClass = (typeof ACTION_CLASSES)[number]

export interface Identity {
  uuid: string
  name: string
  type_code: number
  /** Actor identities: the committed action classes. Other types: the
   * record body they carry (tasks: board reference; may be empty). */
  ceiling: string[]
  profile_commitment: string
  created_at: string
  /** Board linkage for task identities. */
  board?: { board: string; taskId: string; channel: string }
}

interface RegistryFile {
  identities: Identity[]
}

const REGISTRY = 'registry.json'

export function loadRegistry(): Identity[] {
  return readJson<RegistryFile>(REGISTRY, { identities: [] }).identities
}

function saveRegistry(identities: Identity[]): void {
  writeJson(REGISTRY, { identities })
}

export function findByName(name: string): Identity | undefined {
  return loadRegistry().find((i) => i.name === name)
}

export function findByUuid(uuid: string): Identity | undefined {
  return loadRegistry().find((i) => i.uuid === uuid)
}

export function findTaskByBoardId(board: string, taskId: string): Identity | undefined {
  return loadRegistry().find((i) => i.type_code === TYPE_TASK && i.board?.board === board && i.board?.taskId === taskId)
}

export function commitmentFor(name: string, type_code: number, ceiling: string[]): string {
  return sha256(canonical({ name, type_code, ceiling: [...ceiling].sort() }))
}

/**
 * Register an actor Identity. Idempotent for the same name + ceiling: a
 * repeat registration returns the standing record. A name re-registered
 * with a different ceiling is refused — ceilings are committed, and a
 * change is a new Identity, not an edit.
 */
export async function registerActor(name: string, ceiling: string[]): Promise<{ identity: Identity; created: boolean }> {
  const classes = ceiling.map((c) => c.toUpperCase())
  for (const c of classes) {
    if (!(ACTION_CLASSES as readonly string[]).includes(c)) {
      throw new Error(`unknown action class: ${c} (classes: ${ACTION_CLASSES.join(', ')})`)
    }
  }
  const existing = findByName(name)
  if (existing) {
    if (existing.type_code !== TYPE_ACTOR) throw new Error(`${name} is registered as a ${TYPE_NAMES[existing.type_code]}, not an actor`)
    if (canonical(existing.ceiling) !== canonical([...classes].sort())) {
      throw new Error(`${name} is already registered with ceiling [${existing.ceiling.join(', ')}]; a different ceiling is a new Identity, not an edit`)
    }
    return { identity: existing, created: false }
  }
  const identity: Identity = {
    uuid: uuid5(`imbuuid:actor:${name}`),
    name,
    type_code: TYPE_ACTOR,
    ceiling: [...classes].sort(),
    profile_commitment: commitmentFor(name, TYPE_ACTOR, classes),
    created_at: nowIso(),
  }
  const all = loadRegistry()
  all.push(identity)
  saveRegistry(all)
  await sinkIdentity(identity)
  return { identity, created: true }
}

/** Register the Identity of a board task, at post time. */
export async function registerTask(board: string, taskId: string, channel: string, title: string): Promise<Identity> {
  const existing = findTaskByBoardId(board, taskId)
  if (existing) return existing
  const name = `task:${board}:${taskId}`
  const identity: Identity = {
    uuid: uuid5(`imbuuid:task:${board}:${taskId}`),
    name,
    type_code: TYPE_TASK,
    ceiling: [],
    profile_commitment: sha256(canonical({ board, taskId, channel, title })),
    created_at: nowIso(),
    board: { board, taskId, channel },
  }
  const all = loadRegistry()
  all.push(identity)
  saveRegistry(all)
  await sinkIdentity(identity)
  return identity
}

/** True when the actor's committed ceiling contains the action class. */
export function ceilingAdmits(actor: Identity, actionClass: string): boolean {
  return actor.ceiling.includes(actionClass.toUpperCase())
}
