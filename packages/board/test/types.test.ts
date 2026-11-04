import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The published files, as `pretest` builds them into dist/. A project on http() installs none of
// the optional peers, so its type check (with `skipLibCheck` off) mustn't reach them; and A2 is
// inlined, so nothing published imports it at all.
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
const PEERS = /^(chat|@chat-adapter\/|@vercel\/connect)/

/** Every `types` file an export names, in any condition. */
function typesOf(entry: unknown): string[] {
  if (typeof entry !== 'object' || entry === null) return []
  return Object.entries(entry).flatMap(([key, value]) => (key === 'types' && typeof value === 'string' ? [value] : typesOf(value)))
}

/** The bare modules a declaration file reaches, through its relative imports, with the file that names each. */
function reached(start: string): string[] {
  const seen = new Set<string>()
  const found = new Set<string>()
  const stack = [resolve(root, start)]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const [, from] of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (from!.startsWith('.')) stack.push(resolve(dirname(file), from!.replace(/\.mjs$/, '.d.mts')))
      else if (PEERS.test(from!)) found.add(`${from} (in ${file.slice(root.length + 1)})`)
    }
  }
  return [...found].sort()
}

describe('the published types', () => {
  const entries = Object.entries(pkg.exports).filter(([path]) => !/backend-a2|sync-|package\.json/.test(path))

  it.each(entries)('%s reaches no optional peer', (_path, entry) => {
    const types = typesOf(entry)
    expect(types.length).toBeGreaterThan(0)
    expect(types.flatMap(reached)).toEqual([])
  })
})

describe('A2, inlined', () => {
  it('is imported by no published file, code or types', () => {
    const files = readdirSync(resolve(root, 'dist')).filter((name) => /\.(mjs|d\.mts)$/.test(name))
    expect(files.length).toBeGreaterThan(0)
    const imports = files.flatMap((name) => {
      const text = readFileSync(resolve(root, 'dist', name), 'utf8')
      // Statements and dynamic imports only: the bundler's `//#region` comments name A2's files.
      return [...text.matchAll(/^\s*(?:import|export)\b[^;'"]*?from\s*['"](experimental-a2[^'"]*)['"]|\bimport\(\s*['"](experimental-a2[^'"]*)['"]\s*\)/gm)].map(
        (match) => `${name}: ${match[1] ?? match[2]}`,
      )
    })
    expect(imports).toEqual([])
  })
})
