import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A person's Vercel CLI login, as @vercel/oidc reads it.
vi.mock('@vercel/oidc', async (original) => ({
  ...(await original<typeof import('@vercel/oidc')>()),
  getVercelToken: vi.fn(async () => 'vercel-cli-token'),
}))

const { createClient } = await import('../src/client/node.ts')
const { BOARD_URL, personToken, testBoard } = await import('./harness.ts')

const HOST = new URL(BOARD_URL).host
const SECRET = 'automation-bypass-secret'

/** Vercel Authentication's wall: a redirect to vercel.com's login page, which fetch follows to HTML. */
function wall(): Response {
  const response = new Response('<!DOCTYPE html><html>Log in to Vercel</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  Object.defineProperty(response, 'redirected', { value: true })
  Object.defineProperty(response, 'url', { value: `https://vercel.com/sso-api?url=${encodeURIComponent(BOARD_URL)}` })
  return response
}

/** A protected board, and the slice of the Vercel API `vercel curl` uses to get through. */
function protectedBoard(options: { bypass?: Record<string, { scope: string }>; access?: boolean } = {}) {
  const board = testBoard()
  let bypass = options.bypass ?? {}
  const api: string[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.host === 'api.vercel.com') {
      api.push(`${request.method} ${url.pathname}${url.search}`)
      if (request.headers.get('authorization') !== 'Bearer vercel-cli-token' || options.access === false)
        return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
      if (url.pathname === `/v13/deployments/${HOST}`)
        return Response.json({ projectId: 'prj_board', ownerId: 'team_board' })
      if (url.pathname === '/v9/projects/prj_board' && url.searchParams.get('teamId') === 'team_board')
        return Response.json({ id: 'prj_board', protectionBypass: bypass })
      if (url.pathname === '/v1/projects/prj_board/protection-bypass' && request.method === 'PATCH') {
        bypass = { ...bypass, [SECRET]: { scope: 'automation-bypass' } }
        return Response.json({ protectionBypass: bypass })
      }
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    }
    if (request.headers.get('x-vercel-protection-bypass') !== SECRET) return wall()
    return board.fetch(request)
  }) as typeof globalThis.fetch
  return { fetch, api }
}

describe('a board behind Vercel Deployment Protection', () => {
  let config: string
  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), 'vboard-protection-'))
    vi.stubEnv('XDG_CONFIG_HOME', config)
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(config, { recursive: true, force: true })
  })

  it("gets through with the project's automation bypass, like `vercel curl`", async () => {
    const { fetch, api } = protectedBoard({ bypass: { [SECRET]: { scope: 'automation-bypass' } } })
    const client = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    const root = await client.post('dev', 'through the wall')
    expect((await client.thread(root.id)).message.text).toBe('through the wall')
    expect(api).toEqual([`GET /v13/deployments/${HOST}`, 'GET /v9/projects/prj_board?teamId=team_board'])

    // The secret is cached: a new process doesn't ask Vercel again.
    api.length = 0
    const again = createClient({ url: BOARD_URL, token: await personToken(), handle: 'jb', fetch })
    expect((await again.discovery()).url).toBe(BOARD_URL)
    expect(api).toEqual([])
  })

  it('creates the automation bypass when the project has none', async () => {
    const { fetch, api } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    expect((await client.discovery()).url).toBe(BOARD_URL)
    expect(api).toContain('PATCH /v1/projects/prj_board/protection-bypass?teamId=team_board')
  })

  it("says so when your Vercel account can't get through", async () => {
    const { fetch } = protectedBoard({ access: false })
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      name: 'BoardError',
      code: 'protected',
      message: expect.stringMatching(/Deployment Protection/),
    })
  })

  it('says so when VERCEL_AUTOMATION_BYPASS_SECRET is wrong', async () => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'wrong')
    const { fetch } = protectedBoard()
    const client = createClient({ url: BOARD_URL, token: await personToken(), fetch })
    await expect(client.discovery()).rejects.toMatchObject({
      code: 'protected',
      message: expect.stringMatching(/VERCEL_AUTOMATION_BYPASS_SECRET/),
    })
  })
})
