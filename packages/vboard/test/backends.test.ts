import { describe, expect, it, vi } from 'vitest'
import { connect } from '../src/client/node.ts'
import { memory } from '../src/store/memory.ts'
import { board, HttpError, type Backend, type Caller } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { a2 } from '../src/backend-a2/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, signedInHome, TEAM_ID, testAuth, testBoard } from './harness.ts'

/** Where v0's board is mounted: a board on the team's board, over http(). */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'

/** The team's board, and v0's board using it over http(), calling each other in-process. */
function team(options: Parameters<typeof http>[1] = {}) {
  const remote = testBoard({ access: [vercelProject({ project: 'prj_v0', can: 'all' }), vercelProject({ project: 'prj_marketing', can: 'all' })] })
  const seen: Request[] = []
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    seen.push(request.clone())
    if (request.url.startsWith(BOARD_URL)) return remote.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const project = board({
    backend: http(BOARD_URL, { fetch: bearer(route, () => deploymentToken('v0', 'prj_v0', 'production')), ...options }),
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
    expect((await julian('POST', '/wake', {})).status).toBe(404)
    expect(await (await fetch(new Request(`${BOARD_URL}/health`))).json()).toEqual({ ok: true })
    // And nothing reaches it without a token.
    expect((await fetch(new Request(`${BOARD_URL}/messages`))).status).toBe(401)
    expect(calls).toHaveLength(3)

    // Your own code is `{ self }`: the backend decides who that is.
    const own = board({ backend: { ...mine, bind: () => {} } as Backend, url: BOARD_URL })
    await own.messages()
    expect(calls.at(-1)!.caller).toEqual({ self: null, origin: { via: { kind: 'client', name: null } } })
    await own.as('deploys').messages()
    expect(calls.at(-1)!.caller).toEqual({ self: 'deploys', profile: 'deploys', origin: { via: { kind: 'client', name: 'deploys' } } })
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
  it('answers only wake-ups and webhooks, and its handle reads the board it uses', async () => {
    const { project } = team()
    const nothing = { error: { code: 'not_found', message: `${V0_URL} answers only wake-ups and webhooks` } }
    // No discovery to send anyone elsewhere: a repo links the team's board itself.
    const discovery = await project.fetch(new Request(V0_URL))
    expect([discovery.status, await discovery.json()]).toEqual([404, nothing])
    expect(await (await julianOn(project.fetch, V0_URL))('GET', '/messages')).toEqual({ status: 404, body: nothing })
    // Its own handle asks the board it uses.
    expect(await project.discovery()).toMatchObject({ url: BOARD_URL, audience: BOARD_URL })
  })

  it('reaches the board it uses with the credentials `vb` finds, minting one for that board', async () => {
    const { remote } = team()
    await signedIn([BOARD_URL])
    const seen: string[] = []
    const route = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(`${request.method} ${request.url}`)
      return remote.fetch(request)
    }
    const here = board({ backend: http(BOARD_URL, { fetch: connect(BOARD_URL, { fetch: route as typeof fetch }).fetch }) }).as(null)
    expect((await here.me()).principal).toBe('vercel:user:u_julian')
    expect((await here.post('dev', 'from a script')).text).toBe('from a script')
    // Discovery first, for the project to mint for, then the calls, each with the token it minted.
    expect(seen).toEqual([`GET ${BOARD_URL}`, `GET ${BOARD_URL}/me`, `POST ${BOARD_URL}/messages`])
    vi.unstubAllEnvs()
  })

  it("writes from your own code as its deployment, idempotent by the post's id", async () => {
    const { remote, project } = team()
    const deploys = project.as('deploys')
    await deploys.post('deploys', { text: 'a1b2c3 is live', id: 'd1' })
    await deploys.post('deploys', { text: 'a1b2c3 is live', id: 'd1' })
    await project.as('deploys').post('deploys', { text: 'd4e5f6 is live', id: 'd2' })
    expect((await deploys.posted('d2')).text).toBe('d4e5f6 is live')
    await expect(project.as('deploy_bot').post('deploys', 'x')).rejects.toThrow('start with a letter and use up to 32 letters, numbers, and hyphens')

    const { body } = await (await julianOn(remote.fetch))('GET', '/messages?channel=deploys')
    expect(body.messages.map((message: { text: string; by: { actor: string } }) => [message.text, message.by.actor])).toEqual([
      ['a1b2c3 is live', `${V0}+deploys`],
      ['d4e5f6 is live', `${V0}+deploys`],
    ])
  })

  it("keeps a handle's post IDs its own, so no one can take one first", async () => {
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
    // v0's own post still lands, its ID under its own principal.
    expect((await project.as('deploys').post('deploys', { text: 'a1b2c3 is live', id: 'd1' })).id).toEqual(expect.any(String))
    // Even one it names as someone else's key.
    expect((await project.post('deploys', { text: 'still mine', id: `key:vercel:project:prj_marketing:production:abc` })).text).toBe('still mine')
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
