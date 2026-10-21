import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { describe, expect, it } from 'vitest'

/** Node's built-in modules, by either name, as an import or a re-export of one. */
const NODE = /\b(?:from|import)\s*\(?\s*["'](?:node:[\w/]+|(?:fs|path|os|crypto|child_process|http|https|net|dns|util|async_hooks|stream|url|module|worker_threads)(?:\/[\w/]+)?)["']/

/** What a bundle of `files` brings along from Node, file by file. */
async function nodeImports(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const name of await readdir(dir, { recursive: true }))
    if (/\.(m?js)$/.test(name)) {
      const match = (await readFile(join(dir, name), 'utf8')).match(NODE)
      if (match) found.push(`${name}: ${match[0]}`)
    }
  return found
}

describe('board() in a browser', () => {
  it('bundles with http() and nothing from Node, as a browser resolves the package', async () => {
    // Inside the package, so `vboard` resolves to itself through its exports, with a browser's conditions.
    const dir = await mkdtemp(join(tmpdir(), 'vboard-browser-'))
    const entry = join(import.meta.dirname, '.browser-entry.ts')
    await writeFile(
      entry,
      [
        "import { board } from 'vboard'",
        "import { http } from 'vboard/backend-http'",
        "export const team = board({ backend: http('https://board.example.com/api/board', { token: 'token' }) })",
        "export const posted = (text: string) => team.as('page').post('dev', text)",
      ].join('\n'),
    )
    try {
      await build({
        config: false,
        entry: { app: entry },
        outDir: dir,
        platform: 'browser',
        format: 'esm',
        dts: false,
        clean: false,
        logLevel: 'silent',
        deps: { alwaysBundle: [/.*/], onlyBundle: false },
      })
      const files = await readdir(dir)
      expect(files.length).toBeGreaterThan(0)
      expect(await nodeImports(dir)).toEqual([])
      // It's the default build it bundled: nothing finds a board in the environment, or verifies a token.
      const bundle = (await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))).join('\n')
      expect(bundle).not.toContain('VBOARD_TOKEN')
      expect(bundle).not.toContain('jwtVerify')
      expect(bundle).not.toContain('createRemoteJWKSet')
    } finally {
      await rm(entry, { force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("is what the inspector's page runs on, built for a browser", async () => {
    const page = await readFile(join(import.meta.dirname, '../dist/inspect/app.js'), 'utf8')
    expect(page.match(NODE)).toBeNull()
  })
})
