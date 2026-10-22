import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A person's Vercel CLI login, as @vercel/oidc reads it, and the exchange that binds a development token to a URL.
const login = vi.hoisted(() => ({ token: 'vercel-cli-token' as string | null }))
const exchange = vi.hoisted(() => vi.fn(async (_options: { token: string; audience: string }) => ''))
vi.mock('@vercel/oidc', async (original) => ({
  ...(await original<typeof import('@vercel/oidc')>()),
  getVercelToken: vi.fn(async () => {
    if (!login.token) throw new Error('not logged in')
    return login.token
  }),
  exchangeVercelOidcToken: exchange,
}))

const { board } = await import('../src/server/index.ts')
const { http } = await import('../src/backend-http/index.ts')
const { BOARD_URL, personToken, testBoard } = await import('./harness.ts')

const EVIL = 'https://evil.example/api/board'
const LOCAL = 'http://localhost:3000/api/board'

/**
 * The Vercel API as your login sees it: the hosts it resolves to a project (with or
 * without a `teamId`, which must be the owner's), and a development token for any
 * project you can access, here `prj_board` and `prj_victim`. Every call is recorded.
 */
function vercel(hosts: Record<string, { projectId: string; ownerId: string }>) {
  const calls: string[] = []
  const handle = (request: Request) => {
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}${url.search}`)
    if (request.headers.get('authorization') !== 'Bearer vercel-cli-token')
      return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
    const team = url.searchParams.get('teamId')
    const host = url.pathname.match(/^\/v13\/deployments\/([^/]+)$/)?.[1]
    const found = host ? hosts[decodeURIComponent(host)] : undefined
    if (found && (!team || team === found.ownerId)) return Response.json({ ...found, url: 'board-abc123.vercel.app' })
    if (url.pathname === '/v2/teams') return Response.json({ teams: [{ id: 'team_test' }, { id: 'team_victim' }] })
    if (url.pathname === '/v2/user') return Response.json({ user: { username: 'julian', name: 'Julian' } })
    const minted = url.pathname.match(/^\/v1\/projects\/(prj_board|prj_victim)\/token$/)?.[1]
    if (minted && request.method === 'POST') return Response.json({ token: `development-token-for-${minted}` })
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  }
  return { handle, calls }
}

/** A board at EVIL whose discovery says it's `prj_victim`, a project you can access. */
function evilBoard(teamId: string | null) {
  return (request: Request) =>
    request.method === 'GET' && request.url === EVIL
      ? Response.json({ version: '0', url: EVIL, audience: EVIL, team_id: teamId, project_id: 'prj_victim', sync: [] })
      : Response.json({ channels: [] })
}

describe("a person's token from `vercel login`", () => {
  let config: string
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), 'vboard-login-'))
    for (const key of Object.keys(process.env))
      if (/^(VBOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)) vi.stubEnv(key, '')
    vi.stubEnv('XDG_CONFIG_HOME', config)
    login.token = 'vercel-cli-token'
    exchange.mockReset().mockImplementation(async ({ audience }) => personToken('u_julian', audience))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(config, { recursive: true, force: true })
  })

  // Requests to api.vercel.com reach `api`; everything else reaches the board, which records each bearer it's sent.
  function network(api: ReturnType<typeof vercel>, board: (request: Request) => Response | Promise<Response>) {
    const bearers: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).host === 'api.vercel.com') return api.handle(request)
      const bearer = request.headers.get('authorization')
      if (bearer) bearers.push(bearer)
      return board(request)
    })
    return bearers
  }
  /** A handle on the board at `url`, reaching it the way `vb` does. */
  const client = (url: string) => board({ backend: http(url) })

  it("is minted for the project Vercel says the board's host is a deployment of", async () => {
    const api = vercel({ 'board.test': { projectId: 'prj_board', ownerId: 'team_test' } })
    const board = testBoard()
    const bearers = network(api, (request) => board.fetch(request))
    expect(await client(BOARD_URL).channels()).toEqual([])
    expect(api.calls).toEqual([
      'GET /v13/deployments/board.test',
      'POST /v1/projects/prj_board/token?source=vboard&teamId=team_test',
      'GET /v2/user',
    ])
    expect(exchange).toHaveBeenCalledWith({ token: 'development-token-for-prj_board', audience: BOARD_URL })
    expect(bearers).toEqual([`Bearer ${await exchange.mock.results[0]!.value}`])
  })

  it("isn't minted for a board whose discovery names a project its host isn't a deployment of", async () => {
    // evil.example is the attacker's own Vercel project, and its discovery claims yours.
    const api = vercel({ 'evil.example': { projectId: 'prj_evil', ownerId: 'team_evil' } })
    const bearers = network(api, evilBoard(null))
    await expect(client(EVIL).channels()).rejects.toMatchObject({
      code: 'wrong_project',
      message: `the board at ${EVIL} says its project is prj_victim, but it's a deployment of prj_evil, so vb won't sign in to it`,
    })
    expect(api.calls).toEqual(['GET /v13/deployments/evil.example'])
    expect(exchange).not.toHaveBeenCalled()
    expect(bearers).toEqual([])
  })

  it("isn't minted for a host Vercel won't resolve for you, whatever team its discovery names", async () => {
    const api = vercel({})
    const bearers = network(api, evilBoard('team_victim'))
    await expect(client(EVIL).channels()).rejects.toMatchObject({
      code: 'no_access',
      message: "your Vercel login can't see the project evil.example belongs to: run `vercel login` or ask for access to it",
    })
    expect(api.calls.length).toBeGreaterThan(0)
    expect(api.calls.filter((call) => !call.startsWith('GET '))).toEqual([])
    expect(exchange).not.toHaveBeenCalled()
    expect(bearers).toEqual([])
  })

  it("is minted for a loopback board's own project, which Vercel has no host for", async () => {
    const api = vercel({})
    const board = testBoard({ url: LOCAL })
    const bearers = network(api, (request) => board.fetch(request))
    expect(await client(LOCAL).channels()).toEqual([])
    expect(api.calls).toEqual(['POST /v1/projects/prj_board/token?source=vboard&teamId=team_test', 'GET /v2/user'])
    expect(exchange).toHaveBeenCalledWith({ token: 'development-token-for-prj_board', audience: LOCAL })
    expect(bearers).toHaveLength(1)
  })

  it('looks the host up with the Vercel CLI when the login is in the keychain, before it mints', async () => {
    login.token = null
    // A signed-in `vercel` that logs each call: the API through `vercel api`, and `vercel project token`.
    const bin = await mkdtemp(join(tmpdir(), 'vboard-bin-'))
    const log = join(bin, 'calls')
    await writeFile(
      join(bin, 'vercel'),
      [
        '#!/bin/sh',
        `echo "$*" >> ${log}`,
        'case "$1 $2" in',
        '  "whoami "*) echo julian ;;',
        `  "api /v13/deployments/board.test") echo '{"projectId":"prj_board","ownerId":"team_test"}' ;;`,
        `  "api /v13/deployments/evil.example") echo '{"projectId":"prj_evil","ownerId":"team_evil"}' ;;`,
        `  "project token") echo '{"token":"development-token"}' ;;`,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', bin)
    const api = vercel({})
    try {
      const evil = network(api, evilBoard(null))
      await expect(client(EVIL).channels()).rejects.toMatchObject({ code: 'wrong_project' })
      expect(evil).toEqual([])
      const board = testBoard()
      network(api, (request) => board.fetch(request))
      expect(await client(BOARD_URL).channels()).toEqual([])
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
        'whoami --non-interactive',
        'api /v13/deployments/evil.example -X GET --raw --non-interactive',
        'api /v13/deployments/board.test -X GET --raw --non-interactive',
        'project token prj_board --format=json --scope team_test',
      ])
      expect(api.calls).toEqual([])
      expect(exchange.mock.calls).toEqual([[{ token: 'development-token', audience: BOARD_URL }]])
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })
})
