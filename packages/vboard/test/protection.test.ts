import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A person's Vercel CLI login, as @vercel/oidc reads it.
const login = vi.hoisted(() => ({ token: 'vercel-cli-token' as string | null }))
vi.mock('@vercel/oidc', async (original) => ({
  ...(await original<typeof import('@vercel/oidc')>()),
  getVercelToken: vi.fn(async () => {
    if (!login.token) throw new Error('not logged in')
    return login.token
  }),
}))

const { createClient } = await import('../src/client/node.ts')
const { BOARD_URL, personToken, testBoard } = await import('./harness.ts')

const HOST = new URL(BOARD_URL).host
const SECRET = 'automation-bypass-secret'

/**
 * A board behind Vercel Authentication (a 302 to vercel.com/sso-api without the
 * secret), and the slice of the Vercel API `vercel curl` uses to get through:
 * the host is a deployment in one of your teams, not your own scope.
 */
function protectedBoard(
  options: { bypass?: Record<string, { scope: string }>; canCreate?: boolean; canRead?: boolean; page?: boolean } = {},
) {
  const board = testBoard()
  let bypass = options.bypass ?? {}
  const api: string[] = []
  const sent: (string | null)[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.host === 'api.vercel.com') {
      api.push(`${request.method} ${url.pathname}${url.search}`)
      if (request.headers.get('authorization') !== 'Bearer vercel-cli-token')
        return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
      const team = url.searchParams.get('teamId')
      if (url.pathname === '/v2/teams') return Response.json({ teams: [{ id: 'team_other' }, { id: 'team_board' }] })
      if (url.pathname === `/v13/deployments/${HOST}` && team === 'team_board')
        return Response.json({ projectId: 'prj_board', ownerId: 'team_board' })
      if (url.pathname === '/v9/projects/prj_board' && team === 'team_board') {
        if (options.canRead === false) return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        const sso = options.page ? null : { deploymentType: 'all_except_custom_domains' }
        return Response.json({ id: 'prj_board', name: 'board', protectionBypass: bypass, ssoProtection: sso, passwordProtection: null })
      }
      if (url.pathname === '/v1/projects/prj_board/protection-bypass' && request.method === 'PATCH' && team === 'team_board') {
        if (options.canCreate === false) return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        bypass = { ...bypass, [SECRET]: { scope: 'automation-bypass' } }
        return Response.json({ protectionBypass: bypass })
      }
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    }
    sent.push(request.headers.get('x-vercel-protection-bypass'))
    // A plain website, not a board: an HTML page whatever you send.
    if (options.page) return new Response('<!DOCTYPE html><h1>Welcome</h1>', { headers: { 'content-type': 'text/html' } })
    if (request.headers.get('x-vercel-protection-bypass') !== SECRET)
      return new Response('Protected by Vercel Authentication', {
        status: 302,
        headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(request.url)}`, 'content-type': 'text/plain' },
      })
    return board.fetch(request)
  }) as typeof globalThis.fetch
  return { fetch, api, sent }
}

describe('a board behind Vercel Deployment Protection, without VERCEL_AUTOMATION_BYPASS_SECRET', () => {
  let config: string
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), 'vboard-protection-'))
    vi.stubEnv('XDG_CONFIG_HOME', config)
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
    login.token = 'vercel-cli-token'
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(config, { recursive: true, force: true })
  })

  it("gets through with the project's automation bypass, read with your Vercel login, and caches it", async () => {
    const { fetch, api, sent } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    const root = await client.post('dev', 'through the wall')
    expect((await client.thread(root.id)).message.text).toBe('through the wall')
    expect(api).toEqual([
      `GET /v13/deployments/${HOST}`,
      `GET /now/aliases/${HOST}`,
      'GET /v2/teams?limit=100',
      `GET /v13/deployments/${HOST}?teamId=team_other`,
      `GET /v13/deployments/${HOST}?teamId=team_board`,
      'GET /v9/projects/prj_board?teamId=team_board',
    ])
    expect(sent.slice(1).every((header) => header === SECRET)).toBe(true)

    // A new process sends the cached secret from the start, without asking Vercel.
    api.length = 0
    sent.length = 0
    login.token = null
    const again = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await again.discovery()).url).toBe(BOARD_URL)
    expect(api).toEqual([])
    expect(sent).toEqual([SECRET])
  })

  it('creates the automation bypass when the project has none, and says so', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('PATCH /v1/projects/prj_board/protection-bypass?teamId=team_board')
    expect(stderr).toHaveBeenCalledWith('created a Protection Bypass for Automation on the Vercel project board\n')
  })

  it('looks the secret up again when the cached one is stale', async () => {
    const { fetch } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    await createClient({ url: BOARD_URL, token: await personToken(), fetch }).discovery()
    const [file] = await readdir(join(config, 'vboard', 'bypass'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(config, 'vboard', 'bypass', file!), JSON.stringify({ host: HOST, secret: 'revoked' }))
    const { fetch: again, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    expect((await createClient({ url: BOARD_URL, token: await personToken(), fetch: again }).discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('GET /v9/projects/prj_board?teamId=team_board')
  })

  it("says so when your Vercel login can't see the project", async () => {
    login.token = 'someone-else'
    vi.stubEnv('PATH', '')
    const { fetch } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: `${BOARD_URL} is behind Vercel Deployment Protection, and your Vercel login can't see its project: run \`vercel login\` or ask for access, or set VERCEL_AUTOMATION_BYPASS_SECRET (Project → Settings → Deployment Protection → Protection Bypass for Automation)`,
    })
  })

  it("says so when your Vercel login can't create the bypass", async () => {
    const { fetch } = protectedBoard({ canCreate: false })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining("can't read or create its project's automation bypass"),
    })
  })

  it("doesn't create a bypass on an unprotected project that answers with a web page", async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetch, api } = protectedBoard({ page: true })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'no_board',
      message: `no board at ${BOARD_URL}: it answered with a web page, and its Vercel project isn't protected`,
    })
    expect(api.some((call) => call.startsWith('PATCH'))).toBe(false)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("doesn't create a second bypass when it can't read the project's settings", async () => {
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } }, canRead: false })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining("can't read its project's settings"),
    })
    expect(api.some((call) => call.startsWith('PATCH'))).toBe(false)
  })

  it('uses VERCEL_AUTOMATION_BYPASS_SECRET when set, without asking Vercel', async () => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'wrong')
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringContaining('rejected VERCEL_AUTOMATION_BYPASS_SECRET'),
    })
    expect(api).toEqual([])
  })
})
