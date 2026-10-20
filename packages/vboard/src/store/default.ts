import { sqliteDb } from './sqlite-db.ts'
import { sqlTables } from './sql.ts'
import type { BoardStore, MessageTables } from './types.ts'

const unconfigured = (): MessageTables => {
  const fail = async (): Promise<never> => {
    throw new Error("vboard needs a store in production: board({ store: postgres({ connectionString }) }) from 'vboard/store-postgres'")
  }
  return {
    position: fail, apply: fail, applyNext: fail, message: fail, byEventId: fail, messagesAt: fail, thread: fail, messages: fail, threads: fail,
    syncOf: fail, threadOf: fail, copiesOf: fail, messageOf: fail, externalThreads: fail, recentRoots: fail, withAttachment: fail,
    close: async () => {},
  }
}

/**
 * A board given no store: its log on A2's default for the environment (SQLite at
 * `.a2/dev.db` in development, memory in tests, an error in production), and its
 * tables beside it.
 */
export function defaultStore(): BoardStore {
  const env = process.env.NODE_ENV
  if (env === 'production') return { log: undefined, tables: unconfigured(), close: async () => {} }
  const tables = sqlTables(sqliteDb(env === 'test' ? ':memory:' : '.a2/dev.db'))
  return { log: undefined, tables, close: () => tables.close() }
}
