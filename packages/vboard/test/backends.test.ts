import { describe, expect, it, vi } from 'vitest'
import { createClient } from '../src/client/node.ts'
import { memory } from '../src/store/memory.ts'
import { board, HttpError, type Backend, type Caller } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { a2 } from '../src/backend-a2/index.ts'
import { http } from '../src/backend-http/index.ts'
import { fakeQueue } from './queue.ts'
import { BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, signedInHome, TEAM_ID, testAuth, testBoard } from './harness.ts'

/** Where v0's board is mounted: a board on the team's board, over http(). */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'

/** The team's board, and v0's board using it over http(), calling each other in-process. */
function team(options: Parameters<typeof http>[1] = {}, remoteOptions: Parameters<typeof testBoard>[0] = {}) {
  const remote = testBoard({ access: [vercelProject({ project: 'prj_v0', can: 'all' }), vercelProject({ project: 'prj_marketing', can: 'all' })], ...remoteOptions })
  const seen: Request[] = []
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    seen.push(request.clone())
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const project = board({
    backend: http(BOARD_URL, { fetch: route as typeof fetch, token: () => deploymentToken('v0', 'prj_v0', 'production'), ...options }),
    url: V0_URL,
    // v0's own people sign in to it, as to any board.
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    auth: testAuth,
  })
  return { remote, project, seen }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>, audience?: string) =>
  caller(fetch, await personToken('u_julian', audience), { 'x-board-handle': 'julian' })

/** Julian, signed in to each board as `vercel login` leaves it, for a client in this process. */
async function signedIn(audiences: string[]) {
  vi.stubEnv('XDG_CONFIG_HOME', await signedInHome(audiences))
  vi.stubEnv('VBOARD_TOKEN', '')
  vi.stubEnv('VERCEL', '')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '')
}

describe('board() and its backend', () => {
  it("takes a URL, which TypeScript can't check", () => {
    expect(() => http('board.example.com')).toThrow("http: board.example.com isn't a URL")
  })

  it('keeps the board here with a2()', async () => {
    const backend = a2({ store: memory() })
    const here = board({ backend, url: BOARD_URL })
    const discovery = await (await here.fetch(new Request(BOARD_URL))).json()
    expect(discovery).toMatchObject({ url: BOARD_URL })
    expect(discovery.remote).toBeUndefined()
    expect(discovery.capabilities).toBeUndefined()
    // a2()'s own extras are on the backend: its A2 servers, for a shared scheduler.
    expect(backend.servers.length).toBeGreaterThan(0)
    expect(() => board({ backend, url: BOARD_URL })).toThrow('a2: this backend already serves a board')
  })

  it('serves the protocol on a backend of your own, calling each method with the verified caller and its parsed input', async () => {
    const calls: { method: string; caller: Caller; input: unknown }[] = []
    const record = (method: string) => async (caller: Caller, input: unknown) => {
      calls.push({ method, caller, input })
      return { messages: [], cursor: '0' }
    }
    const mine = {
      remote: null,
      issuers: [],
      routes: [{ method: 'GET', path: '/health', auth: false, handle: async () => Response.json({ ok: true }) }],
      bind: () => {},
      messages: record('messages'),
      async post(caller: Caller, input: { channel?: string; text: string }) {
        calls.push({ method: 'post', caller, input })
        if (input.channel === 'missing') throw new HttpError(404, 'message_not_found', 'message not found: #nope')
        return { message: { id: 'm1', channel: input.channel, text: input.text } }
      },
    } as unknown as Backend
    const { fetch } = board({ backend: mine, url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: testAuth })
    const julian = await julianOn(fetch)

    expect(await julian('GET', '/messages?channel=dev&label=state=open|draft&limit=5')).toEqual({ status: 200, body: { messages: [], cursor: '0' } })
    expect(await julian('POST', '/messages', { channel: 'dev', text: 'hello' })).toMatchObject({ status: 201, body: { message: { id: 'm1' } } })
    expect(calls.map(({ method, input }) => [method, input])).toEqual([
      ['messages', { channel: 'dev', label: [['state', ['open', 'draft']]], limit: 5 }],
      ['post', { channel: 'dev', text: 'hello' }],
    ])
    expect(calls[0]!.caller).toMatchObject({
      identity: { principal: { id: 'vercel:user:u_julian', kind: 'person' }, actor: { id: 'vercel:user:u_julian', handle: 'julian' } },
      origin: { via: { kind: 'api' } },
    })
    // Who's calling, and nothing about what it may do: that's the backend's to decide.
    const { caller: first } = calls[0]!
    expect('identity' in first && 'access' in first.identity.principal).toBe(false)

    // What it throws, it answers; what doesn't validate never reaches it.
    expect(await julian('POST', '/messages', { channel: 'missing', text: 'hi' })).toEqual({
      status: 404,
      body: { error: { code: 'message_not_found', message: 'message not found: #nope' } },
    })
    expect((await julian('POST', '/messages', { channel: 'Not A Channel', text: 'hi' })).status).toBe(400)
    expect(calls).toHaveLength(3)

    // A route it doesn't own, protocol or not, isn't there; its own routes are.
    expect((await julian('GET', '/channels')).status).toBe(404)
    expect((await julian('POST', '/stuck/redrive', { session: 'board', index: 1, action: 'skip' })).status).toBe(404)
    expect(await (await fetch(new Request(`${BOARD_URL}/health`))).json()).toEqual({ ok: true })
    // And nothing reaches it without a token.
    expect((await fetch(new Request(`${BOARD_URL}/messages`))).status).toBe(401)
    expect(calls).toHaveLength(3)

    // Your own code is `{ self }`: the backend decides who that is.
    await board({ backend: { ...mine, bind: () => {} } as Backend, url: BOARD_URL }).client('deploys').messages()
    expect(calls.at(-1)!.caller).toEqual({ self: 'deploys', origin: { via: { kind: 'client', name: 'deploys' } } })
  })

  it('takes a backend made from another, with one method changed', async () => {
    const kept = a2({ store: memory() })
    const backend: Backend = {
      ...kept,
      async delete() {
        throw new HttpError(403, 'forbidden', 'messages on this board stay')
      },
    }
    const { fetch } = board({ backend, url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: testAuth })
    const julian = await julianOn(fetch)
    const id = (await julian('POST', '/messages', { channel: 'dev', text: 'kept' })).body.message.id
    expect(await julian('POST', `/messages/${id}/delete`, {})).toEqual({ status: 403, body: { error: { code: 'forbidden', message: 'messages on this board stay' } } })
    expect((await julian('GET', `/messages/${id}`)).body.message.text).toBe('kept')
    // What it spread was a2()'s methods, not what a2() builds once it's bound.
    expect(kept.servers.length).toBeGreaterThan(0)
  })
})

describe('a board on http()', () => {
  it('keeps no log, and sends clients to the board it uses', async () => {
    // With a token in the environment, a client skips discovery; this is the one without.
    vi.stubEnv('VBOARD_TOKEN', '')
    const { project } = team()
    const discovery = await (await project.fetch(new Request(V0_URL))).json()
    expect(discovery).toMatchObject({ url: V0_URL, remote: BOARD_URL })

    expect(await (await julianOn(project.fetch, V0_URL))('GET', '/messages')).toEqual({
      status: 404,
      body: { error: { code: 'remote', message: `${V0_URL} keeps no log: use ${BOARD_URL}` } },
    })

    vi.unstubAllEnvs()
  })

  it('is followed by a client, which mints a token for the board it uses', async () => {
    const { remote, project } = team()
    await signedIn([V0_URL, BOARD_URL])
    const seen: string[] = []
    const route = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(`${request.method} ${request.url}`)
      return request.url.startsWith(V0_URL) ? project.fetch(request) : remote.fetch(request)
    }
    const client = createClient({ url: V0_URL, fetch: route as typeof fetch, profile: null, session: null })
    expect((await client.me()).principal).toBe('vercel:user:u_julian')
    expect((await client.post('dev', 'from the project')).text).toBe('from the project')
    expect(await client.discovery()).toMatchObject({ url: V0_URL, remote: BOARD_URL })
    // Its discovery, then the other board's, and everything else there.
    expect(seen).toEqual([`GET ${V0_URL}`, `GET ${BOARD_URL}`, `GET ${BOARD_URL}/me`, `POST ${BOARD_URL}/messages`, `GET ${V0_URL}/`])
    vi.unstubAllEnvs()
  })

  it('writes from your own code as its deployment, idempotent by key', async () => {
    const { remote, project } = team()
    await project.client('deploys', { key: 'd1' }).post('deploys', 'a1b2c3 is live')
    await project.client('deploys', { key: 'd1' }).post('deploys', 'a1b2c3 is live')
    await project.client('deploys', { key: 'd2' }).post('deploys', 'd4e5f6 is live')
    await expect(project.client('deploy_bot').post('deploys', 'x')).rejects.toThrow('client: deploy_bot: names start with a letter')

    const { body } = await (await julianOn(remote.fetch))('GET', '/messages?channel=deploys')
    expect(body.messages.map((message: { text: string; by: { actor: string } }) => [message.text, message.by.actor])).toEqual([
      ['a1b2c3 is live', `${V0}+deploys`],
      ['d4e5f6 is live', `${V0}+deploys`],
    ])
  })

  it('schedules from your own code once per key', async () => {
    const { remote, project } = team({}, { scheduler: fakeQueue().scheduler })
    const nudge = () => project.client('deploys', { key: 'd1' }).schedule('deploys', { text: 'is a1b2c3 still live?', in: '1d' })
    const first = await nudge()
    expect((await nudge()).id).toBe(first.id)

    const { body } = await (await julianOn(remote.fetch))('GET', '/schedules')
    expect(body.schedules).toMatchObject([{ id: first.id, by: { actor: `${V0}+deploys` } }])
  })

  it("keeps a client's keyed post IDs its own, so no one can take one first", async () => {
    const { remote, project } = team()
    const marketing = caller(remote.fetch, await deploymentToken('marketing', 'prj_marketing', 'production'))
    const taken = await marketing('POST', '/messages', { channel: 'deploys', text: 'mine now', id: `key:${V0}:0123456789abcdef0123456789abcdef` })
    expect(taken).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_request',
          message: `id: key:… IDs derive from a client's key, and this token's are key:vercel:project:prj_marketing:production:…`,
        },
      },
    })
    expect((await marketing('POST', '/messages', { channel: 'deploys', text: 'fine', id: 'key:vercel:project:prj_marketing:production:abc' })).status).toBe(201)
    // v0's own keyed post still lands, under its own principal.
    expect((await project.client('deploys', { key: 'd1' }).post('deploys', 'a1b2c3 is live')).id).toEqual(expect.any(String))
  })

  it('checks its watchers the way a2() does, and their IDs as profiles', () => {
    expect(() => board({ backend: http(BOARD_URL), url: V0_URL, watch: { review_pi: { tail: 'prs', run: () => {} } } })).toThrow(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    expect(() => board({ backend: http(BOARD_URL), url: V0_URL, watch: { fix: { tail: 'prs --after 3', run: () => {} } } })).toThrow(
      "watch fix: --after isn't a filter",
    )
  })
})
