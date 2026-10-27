import { redisHttp as a2RedisHttp } from 'experimental-a2/store-redis-http'
import { redisTables, type RedisCall } from './redis-tables.ts'
import type { Clock } from 'experimental-a2/server'
import type { BoardStore } from './types.ts'

export type RedisHttpOptions = {
  /** The REST endpoint, e.g. `process.env.UPSTASH_REDIS_REST_URL`. */
  url: string
  /** Its bearer token, e.g. `process.env.UPSTASH_REDIS_REST_TOKEN`. */
  token: string
  /**
   * Isolates boards on one Redis: A2's log and board's tables both live under it. Default `'a2'`.
   * It can't contain braces. board 0.14 (A2 0.22) names every key differently, so a board moves
   * to a new prefix and starts with an empty log: on one board 0.13 wrote, every request answers 503.
   */
  keyPrefix?: string
  /** Stamps every stored time: `migrateFromVboard`'s `replayClock()` keeps each copied event's. */
  clock?: Clock
}

/** A board on Redis over Upstash's REST API: no connection to keep, so it suits functions. */
export function redisHttp(options: RedisHttpOptions): BoardStore {
  const keyPrefix = options.keyPrefix ?? 'a2'
  const log = a2RedisHttp({ url: options.url, token: options.token, keyPrefix, ...(options.clock ? { clock: options.clock } : {}) })
  const call: RedisCall = async (command, ...args) => {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([command, ...args.map(String)]),
    })
    const body = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null
    if (body === null || !response.ok || body.error !== undefined)
      throw new Error(`redis rest command failed: ${body?.error ?? `status ${response.status}`}`)
    return body.result
  }
  return { log, tables: redisTables(call, keyPrefix), close: () => log.close() }
}
