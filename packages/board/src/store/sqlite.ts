import { sqlite as a2Sqlite } from 'experimental-a2/store-sqlite'
import { sqliteDb } from './sqlite-db.ts'
import { sqlTables } from './sql.ts'
import type { Clock } from 'experimental-a2/server'
import type { BoardStore } from './types.ts'

/**
 * A board in one SQLite file, A2's log and board's tables side by side: `a2()`'s
 * store when it's given none, for development, `vb serve`, and a single
 * long-running server. It creates its tables when it opens, and a serverless
 * function, whose files are read-only, can't open it.
 */
export function sqlite(options: { path?: string; clock?: Clock } = {}): BoardStore {
  const path = options.path ?? '.a2/dev.db'
  // A2's store first: it creates the file and switches it to WAL, which the second handle needs.
  const log = a2Sqlite({ path, ...(options.clock ? { clock: options.clock } : {}) })
  let tables: ReturnType<typeof sqlTables>
  try {
    tables = sqlTables(sqliteDb(path))
  } catch (error) {
    // The log's handle is open already: a store that didn't open holds nothing.
    log.close()
    throw error
  }
  return {
    log,
    tables,
    async close() {
      await tables.close()
      log.close()
    },
  }
}
