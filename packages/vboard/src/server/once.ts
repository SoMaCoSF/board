import { AsyncLocalStorage } from 'node:async_hooks'
import { idempotentId } from 'experimental-a2'
import type { OnceView } from '../api/routes.ts'
import { ONCE_RESULT_BYTES_MAX, OnceKey, utf8Bytes, type Json } from '../contract/schemas.ts'
import type { WatcherContext } from './watch.ts'

/**
 * Where an in-process client's derived write IDs come from: its trigger, and a scope inside it.
 * Each source counts its own writes, so a `fn` that a retry skips shifts nothing after it.
 */
export type Writes = { readonly trigger: string; readonly scope: readonly string[]; made: number }

/** A client's writes outside any `once`: `(trigger, 'client', n)`, counted from 0. */
export const writesOf = (trigger: string): Writes => ({ trigger, scope: [], made: 0 })

/**
 * The `once` whose `fn` is running, tagged with the run that owns it. Anything else that inherits
 * the async context (another client, a consumer A2 drains in-process) isn't that run's.
 */
const inside = new AsyncLocalStorage<{ run: Writes; writes: Writes }>()

/** The next derived ID for a write by `run`'s client: from the innermost `once` of that run whose `fn` it's in, else from the run. */
export function nextWriteId(run: Writes): Promise<string> {
  const current = inside.getStore()
  const writes = current?.run === run ? current.writes : run
  return idempotentId('vboard-inbound', writes.trigger, 'client', ...writes.scope, String(writes.made++))
}

/** Where a watcher's once records live: its backend's `once` and `recordOnce`, called as the watcher. */
export type OnceRecords = {
  read(key: string): Promise<OnceView | null>
  /** Records unless a record stands, and answers the one that stands. */
  record(key: string, result: Json | undefined): Promise<OnceView>
}

/** A run's `once`: `fn` runs unless a record stands for the key, and every caller gets the record. */
export function createOnce(options: { run: Writes; records: OnceRecords }): WatcherContext['once'] {
  const { run, records } = options
  return async function once<T extends Json | void>(key: string, fn: () => Promise<T>): Promise<T> {
    const checked = OnceKey.safeParse(key)
    if (!checked.success) throw new Error(`once: ${checked.error.issues[0]!.message}`)
    const found = await records.read(key)
    if (found) return found.result as T
    const value = await inside.run({ run, writes: { trigger: run.trigger, scope: ['once', key], made: 0 } }, fn)
    const text = JSON.stringify(value)
    const bytes = text === undefined ? 0 : utf8Bytes(text)
    if (bytes > ONCE_RESULT_BYTES_MAX) throw new Error(`once ${key}: its result is ${bytes} bytes as JSON, over ${ONCE_RESULT_BYTES_MAX}: return an ID`)
    return (await records.record(key, text === undefined ? undefined : (JSON.parse(text) as Json))).result as T
  }
}
