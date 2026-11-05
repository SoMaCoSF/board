import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type Failure } from '../src/cli/embedded.ts'
import { main, type Command } from '../src/cli/main.ts'
import { local } from '../src/cli/local.ts'
import { env, url, useBoard } from './cli-harness.ts'
import { fakeMessageboard } from './messageboard.ts'

/** What `run` printed, and the exit code it answered. */
async function capture(run: () => Promise<number>) {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true))
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true))
  try {
    return { code: await run(), stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

/**
 * This process's environment as a fresh machine's, for the CLI: no board, agent, Vercel, or Actions
 * variables, as the subprocess tests clear them, and an empty home, so no cached token answers.
 */
async function isolated(): Promise<string> {
  for (const key of Object.keys(process.env)) if (/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)) vi.stubEnv(key, undefined)
  const home = await mkdtemp(join(tmpdir(), 'board-home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_CONFIG_HOME', home)
  return home
}

/** Markers only the inspector, `serve`, and A2's stores have. */
const MARKERS = { inspector: 'x-inspect-token', serve: 'serving a local board', a2: 'board-tables' }

/** `entry`, bundled as the Vercel CLI bundles what it imports: for Node, every dependency inlined. */
async function bundled(entry: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'board-cli-'))
  const file = join(import.meta.dirname, `.cli-entry-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(file, entry)
  try {
    await build({ config: false, entry: { app: file }, outDir: dir, platform: 'node', format: 'esm', dts: false, clean: false, logLevel: 'silent', deps: { alwaysBundle: [/.*/], onlyBundle: false } })
    const names = (await readdir(dir, { recursive: true })).filter((name) => /\.m?js$/.test(name))
    return (await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))).join('\n')
  } finally {
    await rm(file, { force: true })
    await rm(dir, { recursive: true, force: true })
  }
}

describe('the embedded CLI', () => {
  useBoard()

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('names the app that runs it in help, usage, and errors, and has no serve or inspect', async () => {
    const app = createApp({ appName: 'vercel board' })
    const help = await capture(() => app.run(['help']))
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(/^vercel board \d+\.\d+\.\d+\S*: a message board you mount in one route\n\nusage: vercel board <command> \[options\]\n/)
    expect(help.stdout).not.toMatch(/also installed as|^\s+(serve|inspect) \[/m)
    expect(await capture(() => app.run(['serve']))).toEqual({ code: 2, stdout: '', stderr: 'error: Unknown command serve for vercel board.\n\n  See all commands:\n    vercel board --help\n' })
    expect(await capture(() => app.run(['inspect']))).toMatchObject({ code: 2 })
    const extra = await capture(() => app.run(['conformance', 'extra']))
    expect(extra).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: conformance takes no arguments/) })
    expect(extra.stderr).toContain('    vercel board conformance --help\n')
    expect(await capture(() => app.run(['--nope']))).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Unknown option --nope for vercel board\.\n[\s\S]*    vercel board --help\n$/) })
  })

  it('hands failures and warnings to the app that runs it, to show as its own', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    const failures: [unknown, { json: boolean }][] = []
    const warned: unknown[] = []
    const app = createApp({ appName: 'vercel board', onError: (failure, mode) => void failures.push([failure, mode]), onWarning: (warning) => void warned.push(warning) })
    expect(await capture(() => app.run(['read', '99999']))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(await capture(() => app.run(['read', '99999', '--json']))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(failures).toEqual([
      [expect.objectContaining({ class: 'not_found', reason: 'message_not_found', message: "Couldn't find message #99999." }), { json: false }],
      [expect.objectContaining({ reason: 'message_not_found' }), { json: true }],
    ])
    // Misuse, with how to recover as a command it can run.
    expect(await capture(() => app.run(['raed', 'dev']))).toMatchObject({ code: 2, stderr: '' })
    expect(failures.at(-1)![0]).toMatchObject({ class: 'usage', reason: 'unknown_command', next: [{ argv: ['vercel', 'board', '--help'] }] })
    const posted = await capture(() => app.run(['post', 'warned', 'ping @nobody-here']))
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    expect(warned).toEqual([{ reason: 'unknown_mention', message: '@nobody-here matches no one on the board, so it stays plain text and notifies no one.' }])
    // With --json, the warning is the result's, and the app hears nothing.
    const json = await capture(() => app.run(['post', 'warned', 'ping @nobody-here', '--json']))
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: 'posted', warnings: [{ reason: 'unknown_mention' }] })
    expect(warned).toHaveLength(1)
  })

  it("asks for the app's login and team only when a request needs them, and reaches that team's board with them", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    const sent: (string | null)[] = []
    const teams: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization'))
      const { searchParams } = new URL(String(input instanceof Request ? input.url : input))
      teams.push(searchParams.get('teamId') ?? searchParams.get('slug'))
      return api.fetch(input, init)
    })
    let asked = 0
    let resolved = 0
    const app = createApp({ appName: 'vercel board', login: async () => (asked++, 'user:u_jb'), team: async () => (resolved++, 'team_test') })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      // Help, a typo, and misuse need no login: nothing asks for it.
      for (const args of [['--help'], ['read', '--help'], ['raed', 'dev'], ['read', 'dev', '--nope'], ['react', '1']]) await capture(() => app.run(args))
      expect([asked, resolved, sent]).toEqual([0, 0, []])
      // The team the app resolved, and its login.
      const whoami = await capture(() => app.run(['whoami']))
      expect(whoami).toMatchObject({ code: 0, stdout: expect.stringContaining('source  the Vercel CLI\n') })
      expect([asked > 0, resolved > 0]).toEqual([true, true])
      expect(new Set(sent)).toEqual(new Set(['Bearer user:u_jb']))
      expect(new Set(teams)).toEqual(new Set(['team_test']))
      // --scope still names the team itself.
      ;[resolved, teams.length] = [0, 0]
      expect((await capture(() => app.run(['read', 'general', '--scope', 'acme']))).code).toBe(0)
      expect([resolved, new Set(teams)]).toEqual([0, new Set(['acme'])])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends its requests to Vercel's API through the app's fetch, which adds the login's credentials, never its own", async () => {
    const home = await isolated()
    const api = fakeMessageboard({ slug: 'acme' })
    // The app's fetch, as `vercel board` signs a DPoP login's request: credentials of its own, for this method and URL.
    const signed: string[] = []
    const unsigned = vi.fn()
    const app = createApp({
      appName: 'vercel board',
      login: async () => 'user:u_jb',
      team: async () => 'team_test',
      fetch: async (input, init = {}) => {
        const url = String(input instanceof Request ? input.url : input)
        if (new Headers(init.headers).has('authorization')) unsigned(url)
        signed.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
        return api.fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: 'Bearer user:u_jb' } })
      },
    })
    const fetching = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sent around the app'))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect((await capture(() => app.run(['post', 'general', 'hello']))).code).toBe(0)
      expect(await capture(() => app.run(['read', 'general']))).toMatchObject({ code: 0, stdout: expect.stringContaining('hello') })
      expect(signed).toEqual(expect.arrayContaining([expect.stringMatching(/^POST \/v1\/messageboard\//), expect.stringMatching(/^GET \/v1\/messageboard\//)]))
      expect([unsigned.mock.calls, fetching.mock.calls]).toEqual([[], []])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('fails with what a team it was handed throws, as the app said it, never as an internal error', async () => {
    const home = await isolated()
    const fetching = vi.spyOn(globalThis, 'fetch')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failures: Failure[] = []
    const app = createApp({
      appName: 'vercel board',
      onError: (failure) => failures.push(failure),
      login: async () => 'user:u_jb',
      team: async () => {
        throw new Error('request to https://api.vercel.com/v2/user failed, reason: getaddrinfo ENOTFOUND')
      },
    })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect((await capture(() => app.run(['read', 'general']))).code).toBe(1)
      expect(failures).toMatchObject([
        {
          class: 'platform',
          reason: 'api_error',
          message: "Couldn't tell which team's board to use.",
          details: ['request to https://api.vercel.com/v2/user failed, reason: getaddrinfo ENOTFOUND'],
        },
      ])
      expect([fetching.mock.calls, logged.mock.calls]).toEqual([[], []])
    } finally {
      fetching.mockRestore()
      logged.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("talks to the team's board in Vercel's API when nothing points at another: the linked project's team's, or --scope's", async () => {
    const home = await isolated()
    // Linked a directory up, as an app's root is from its src.
    await mkdir(join(home, 'app', '.vercel'), { recursive: true })
    await mkdir(join(home, 'app', 'src'))
    await writeFile(join(home, 'app', '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_test', projectId: 'prj_app' }))
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const asked: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      asked.push(String(input instanceof Request ? input.url : input))
      return api.fetch(input, init)
    })
    const cwd = process.cwd()
    process.chdir(join(home, 'app', 'src'))
    try {
      const app = createApp({ appName: 'vercel board' })
      const posted = await capture(() => app.run(['post', 'general', 'on the team board']))
      expect(posted).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_1\n$/) })
      // The ID it prints goes back in as it came out.
      const id = posted.stdout.trim()
      expect(await capture(() => app.run(['reply', id, 'a reply']))).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_2\n$/) })
      const thread = await capture(() => app.run(['read', id]))
      expect(thread).toMatchObject({ code: 0, stdout: expect.stringContaining('a reply') })
      expect(thread.stdout).toContain('on the team board')
      const whoami = await capture(() => app.run(['whoami']))
      expect(whoami.code).toBe(0)
      expect(whoami.stdout).toContain('board   https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test\nsource  the Vercel CLI\n')
      const read = await capture(() => app.run(['read', 'general', '--scope', 'acme', '--json']))
      expect(read.code).toBe(0)
      expect(JSON.parse(read.stdout).threads[0]).toMatchObject({ message: { text: 'on the team board' } })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
    const teams = asked.map((at) => {
      const { origin, searchParams } = new URL(at)
      return `${origin} ${searchParams.get('teamId') ?? `slug=${searchParams.get('slug')}`}`
    })
    expect(new Set(teams)).toEqual(new Set(['https://api.vercel.com team_test', 'https://api.vercel.com slug=acme']))
  })

  it("lists a team board's channels by name alone, since Vercel's API counts nothing in them", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      for (const text of ['one', 'two']) expect((await capture(() => app.run(['post', 'dev/web', text, '--scope', 'acme']))).code).toBe(0)
      expect(await capture(() => app.run(['channels', '--scope', 'acme']))).toEqual({ code: 0, stdout: 'dev/\n  dev/web\ngeneral\n', stderr: '' })
      expect(JSON.parse((await capture(() => app.run(['channels', '--scope', 'acme', '--json']))).stdout)).toEqual({ channels: [{ path: 'dev/web' }, { path: 'general' }] })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("takes a team board's message ID as it prints one, bare, wherever a channel or a message goes", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ slug: 'acme' })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const app = createApp({ appName: 'vercel board' })
      const posted = await capture(() => app.run(['post', 'dev', 'deploy failed', '--scope', 'acme']))
      // Printed bare, so it pastes into a shell, where a leading # starts a comment.
      expect(posted).toMatchObject({ code: 0, stdout: expect.stringMatching(/^msg_[0-9a-f-]{36}_1\n$/) })
      const id = posted.stdout.trim()
      expect(await capture(() => app.run(['post', id, 'on it', '--scope', 'acme']))).toMatchObject({ code: 0, stdout: `${id.replace(/_1$/, '_2')}\n` })
      const read = await capture(() => app.run(['read', id, '--scope', 'acme', '--json']))
      expect(read.code).toBe(0)
      expect(JSON.parse(read.stdout)).toMatchObject({ message: { id, text: 'deploy failed' }, replies: [{ text: 'on it' }] })
      // The reply went in the thread, not to a channel named for the ID.
      expect(JSON.parse((await capture(() => app.run(['channels', '--scope', 'acme', '--json']))).stdout)).toEqual({ channels: [{ path: 'dev' }, { path: 'general' }] })
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("says you're not signed in when there's no Vercel login to reach the team's board with", async () => {
    const home = await isolated()
    const fetching = vi.spyOn(globalThis, 'fetch')
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => createApp({ appName: 'vercel board' }).run(['whoami']))).toMatchObject({
        code: 1,
        stderr: "error: You're not logged in to Vercel.\n\n  Log in:\n    vercel login\n",
      })
      expect(fetching.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).startsWith('https://api.vercel.com/v1/messageboard'))).toEqual([])
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("shows what Vercel's API says you may do on a team's board, by your team role or your credentials, and when they stop working", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ me: { 'user:u_jb': { can: { 'dev/': ['read', 'post'], 'ci/': ['read'] }, expiresAt: Date.now() + 90 * 60_000 } } })
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => api.fetch(input, init))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const whoami = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(whoami.code).toBe(0)
      expect(whoami.stdout).toMatch(/^token +expires in 1h 30m$/m)
      expect(whoami.stdout).toMatch(/^can +dev\/  read post\n +ci\/ +read$/m)
      // The team's owner may do everything, which whoami doesn't spell out, with no expiry; a viewer reads.
      const roles = fakeMessageboard({ roles: { u_jb: 'owner', u_ada: 'viewer' } })
      fetching.mockImplementation(async (input, init) => roles.fetch(input, init))
      const owner = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(owner).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Julián Benegas \(vercel:user:u_jb\)\n/) })
      expect(owner.stdout).not.toMatch(/^(can|token) /m)
      vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_ada')
      const viewer = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(viewer.stdout).toMatch(/^can +\*  read$/m)
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends a board token you set to Vercel's API as itself, ahead of your login, from vb and from a CLI that runs board's", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    vi.stubEnv('BOARD_TOKEN', 'board_ada1')
    const api = fakeMessageboard({ tokens: { board_ada1: 'user:u_ada' }, me: { board_ada1: { can: { 'dev/': ['read'] }, expiresAt: null } } })
    const sent: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization'))
      return api.fetch(input, init)
    })
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const whoami = await capture(() => main(['whoami', '--scope', 'test'], { name: 'board', commands: local }))
      expect(whoami.code).toBe(0)
      expect(whoami.stdout).toMatch(/^Ada Lovelace \(vercel:user:u_ada\)\n(.*\n)*source +BOARD_TOKEN\n(.*\n)*can +dev\/  read\n$/)
      expect(new Set(sent)).toEqual(new Set(['Bearer board_ada1']))
      // `vercel board`: its login and its signed fetch go unused, and the token goes as it is.
      sent.length = 0
      let asked = 0
      const signed = vi.fn()
      const app = createApp({ appName: 'vercel board', login: async () => (asked++, 'user:u_jb'), team: async () => 'team_test', fetch: async (input, init) => (signed(), api.fetch(input, init)) })
      expect((await capture(() => app.run(['read', 'general']))).code).toBe(0)
      expect([asked, signed.mock.calls.length]).toEqual([0, 0])
      expect(new Set(sent)).toEqual(new Set(['Bearer board_ada1']))
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("sends a token an app's command hands the CLI's connection to Vercel's API, in place of your login", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard({ tokens: { board_ada2: 'user:u_ada' } })
    const sent: (string | null)[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Request(input, init).headers.get('authorization'))
      return api.fetch(input, init)
    })
    // What `vb conformance` does with a token it minted: the same board, that secret as the credential.
    const probe: Command = {
      spec: { name: 'probe', description: 'who a token is on the board', arguments: [], options: [], examples: [] },
      run: async (_args, { connection, out }) => {
        out((await connection(undefined, { token: 'board_ada2' }).board.me()).actor)
        return 0
      },
    }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => main(['probe', '--scope', 'test'], { name: 'board', commands: { probe } }))).toMatchObject({ code: 0, stdout: 'vercel:user:u_ada\n' })
      expect(new Set(sent)).toEqual(new Set(['Bearer board_ada2']))
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it("reaches a team's board by the URL whoami prints for it, with --url or BOARD_URL, and in its Vercel project with neither", async () => {
    const home = await isolated()
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'user:u_jb')
    const api = fakeMessageboard()
    const asked: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input instanceof Request ? input.url : input)}`)
      return api.fetch(input, init)
    })
    const app = { name: 'board', commands: local }
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const whoami = await capture(() => main(['whoami', '--scope', 'test'], app))
      const board = /^board +(\S+)$/m.exec(whoami.stdout)?.[1]
      expect(board).toBe('https://api.vercel.com/v1/messageboard/boards/brd_test?teamId=team_test')
      asked.length = 0
      expect((await capture(() => main(['post', 'general', 'by its URL', '--url', board!], app))).code).toBe(0)
      // The URL's own board, in its own team: no other is looked for.
      expect(asked.length).toBeGreaterThan(0)
      for (const request of asked) {
        const { pathname, searchParams } = new URL(request.split(' ')[1]!)
        expect(searchParams.get('teamId'), request).toBe('team_test')
        expect(pathname, request).toMatch(/^\/v1\/messageboard\/(boards\/brd_test(\/|$)|me$)/)
      }
      // A board that isn't there says so.
      const missing = board!.replace('brd_test', 'brd_missing')
      expect(await capture(() => main(['whoami', '--url', missing], app))).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error: /) })
      vi.stubEnv('BOARD_URL', board!)
      expect((await capture(() => main(['read', 'general'], app))).stdout).toContain('by its URL')
      vi.stubEnv('BOARD_URL', undefined)
      // In a directory linked to a Vercel project, its team's board, with no URL and no --scope.
      await mkdir(join(home, '.vercel'))
      await writeFile(join(home, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_test', projectId: 'prj_app' }))
      expect((await capture(() => main(['read', 'general'], app))).stdout).toContain('by its URL')
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('says how to point it at a board with the commands it has, standalone, where there is no team board', async () => {
    const home = await isolated()
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => main(['read', 'dev'], { name: 'board', commands: local }))).toMatchObject({
        code: 2,
        stderr: expect.stringMatching(/^error: No board to use\. [\s\S]*\n    vb read dev --scope <TEAM>\n/),
      })
    } finally {
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('leaves the standalone board as it was: serve and inspect in its help, after wait', async () => {
    const help = await capture(() => main(['help'], { name: 'board', commands: local }))
    expect(help.stdout).toMatch(/^usage: board <command> \[options\]      \(also installed as `vb`\)$/m)
    // After wait, in a section of their own, and then the options every command takes.
    expect(help.stdout).toMatch(/\n  wait \[channel\][^\n]*\n\n  inspect +the board in your browser[\s\S]*\n  serve +run a board on this machine[\s\S]*\(or\s+--handle\)\n\nfilters:/)
  })

  it("takes the login the Vercel CLI hands it in VERCEL_AUTH_TOKEN, never a token cached for someone else's", async () => {
    const home = await isolated()
    // A token `vercel login`'s account minted for this board, cached as board caches them.
    const tokens = join(home, 'board', 'tokens')
    await mkdir(tokens, { recursive: true })
    const audience = 'https://board.example/api/board'
    await writeFile(join(tokens, `${createHash('sha256').update(audience).digest('hex').slice(0, 32)}.json`), JSON.stringify({ token: 'someone-elses', expiresAt: Date.now() + 3_600_000, name: null, avatar: null }))
    vi.stubEnv('VERCEL_AUTH_TOKEN', 'vca_from_the_vercel_cli')
    vi.stubEnv('BOARD_URL', 'https://board.example/api/board')
    const asked: string[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      asked.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`)
      if (url.replace(/\/$/, '') === 'https://board.example/api/board') return Response.json({ version: '0', url: 'https://board.example/api/board', audience: 'https://board.example/api/board', team_id: 'team_1', project_id: 'prj_board', sync: [] })
      return Response.json({ error: { code: 'forbidden', message: 'no' } }, { status: 403 })
    })
    try {
      await capture(() => createApp({ appName: 'vercel board' }).run(['whoami']))
    } finally {
      fetching.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
    expect(asked.filter((line) => line.startsWith('https://api.vercel.com/')).every((line) => line.endsWith('Bearer vca_from_the_vercel_cli'))).toBe(true)
    expect(asked.some((line) => line.startsWith('https://api.vercel.com/'))).toBe(true)
  })

  it('leaves no Ctrl-C handler behind once wait or tail is done, since the process it runs in goes on', async () => {
    await isolated()
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', env.BOARD_TOKEN)
    const before = process.listenerCount('SIGINT')
    const app = createApp({ appName: 'vercel board' })
    expect((await capture(() => app.run(['wait', 'quiet', '--timeout', '1s']))).code).toBe(1)
    // No board answers there, so tail fails before it reads anything.
    vi.stubEnv('BOARD_URL', url.replace(/\/api\/board$/, '/nowhere'))
    expect((await capture(() => app.run(['tail', 'quiet']))).code).toBe(1)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('never brings the inspector, serve, or A2 into an app that bundles it', async () => {
    const embedded = await bundled("import { createApp } from '../src/cli/embedded.ts'\nawait createApp({ appName: 'vercel board' }).run(process.argv.slice(2))")
    for (const [what, marker] of Object.entries(MARKERS)) expect(embedded.includes(marker), `${what} in the embedded CLI`).toBe(false)
    // The standalone CLI has all three, so the markers find what they look for.
    const standalone = await bundled("import '../src/cli/bin.ts'")
    for (const [what, marker] of Object.entries(MARKERS)) expect(standalone.includes(marker), `${what} in the standalone CLI`).toBe(true)
  }, 120_000)
})
