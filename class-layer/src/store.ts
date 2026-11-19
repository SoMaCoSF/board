/**
 * store.ts — the class layer's local state, in one data directory.
 *
 * Layout (default ~/workspace/board-estate, override with BOARD_ESTATE_DIR):
 *   board/          the Board itself (local backend: SQLite + attachments)
 *   registry.json   the Identity registry (actors and tasks)
 *   chain.jsonl     the receipt chain, one receipt per line, append-only
 *   claims.json     open board claims this layer holds { taskId: claim }
 *   escrow.json     escrow accounts and holds (test value)
 *   sync-state.json the board-event sync cursor and receipted cursors
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function dataDir(): string {
  const dir = process.env.BOARD_ESTATE_DIR ?? join(process.env.HOME ?? '', 'workspace', 'board-estate')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function boardDir(): string {
  const dir = join(dataDir(), 'board')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson<T>(name: string, fallback: T): T {
  const path = join(dataDir(), name)
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function writeJson(name: string, value: unknown): void {
  writeFileSync(join(dataDir(), name), `${JSON.stringify(value, null, 2)}\n`)
}

export function appendLine(name: string, line: string): void {
  const path = join(dataDir(), name)
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : ''
  writeFileSync(path, prior + line + '\n')
}

export function readLines(name: string): string[] {
  const path = join(dataDir(), name)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0)
}

export function nowIso(): string {
  return new Date().toISOString()
}
