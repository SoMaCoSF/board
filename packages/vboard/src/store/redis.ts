import { redis as a2Redis, type RedisConnection } from 'experimental-a2/store-redis'
import { redisTables } from './redis-tables.ts'
import type { BoardStore } from './types.ts'

/** `ioredis` is an optional peer, installed by the apps that use Redis over TCP. */
const IOREDIS: string = 'ioredis'

export type RedisOptions = {
  /** Isolates boards on one Redis: A2's log and vboard's tables both live under it. Default `'a2'`. */
  keyPrefix?: string
} & (
  | {
      /** The Redis server, as `ioredis` takes it: `redis://…` or `rediss://…`. */
      url: string
    }
  | {
      /** A client you made, shared by A2's log and vboard's tables. Closing the store ends it. */
      client: RedisConnection
    }
)

/**
 * A board on Redis over TCP (`npm i ioredis`): a single server or a provider
 * without cluster mode, since each write is one script across many keys.
 */
export function redis(options: RedisOptions): BoardStore {
  const keyPrefix = options.keyPrefix ?? 'a2'
  if ('client' in options) {
    const log = a2Redis({ client: options.client, keyPrefix })
    // A2 disconnects the client when its store closes, so the tables leave it open.
    const tables = redisTables((command, ...args) => options.client.call(command, ...args), keyPrefix)
    return { log, tables, close: () => log.close() }
  }
  const log = a2Redis({ url: options.url, keyPrefix })
  let client: Promise<RedisConnection> | null = null
  const open = () => (client ??= import(IOREDIS).then(({ default: Redis }) => new Redis(options.url) as RedisConnection))
  const tables = redisTables(async (command, ...args) => (await open()).call(command, ...args), keyPrefix)
  return {
    log,
    tables,
    async close() {
      if (client) (await client).disconnect()
      await log.close()
    },
  }
}
