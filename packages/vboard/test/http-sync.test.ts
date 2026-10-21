import { describe, expect, it, vi } from 'vitest'
import { board, type Middleware } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { slack } from '../src/sync/slack.ts'
import { withUserTokens, type UserTokens } from '../src/sync/users.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, TEAM_ID, testAuth, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

/** Where the support project's board is mounted: a board on the team's, over http(), that syncs Slack itself. */
const SUPPORT_URL = 'https://support.test/api/board'
const SUPPORT = 'vercel:project:prj_support:production'
const supportToken = () => deploymentToken('support', 'prj_support', 'production')

type Read = { id: string; text: string; from: string | null; by: { actor: string }; origin: { thread: string; message: string } | null; reactions: Record<string, string[]> }

/**
 * The team's board on a2(), and the support project's board on http() using it with Slack synced,
 * calling each other in-process: the team's board wakes the project's at `<SUPPORT_URL>/wake`, and the
 * project's pushes, pulls, and writes back over HTTP. The project may do everything in `can`.
 */
/** Slack's Web API as a person's token sees it: every token is Julian's. */
const juliansSlack = { auth: { test: async () => ({ user_id: 'U_JULIAN', user: 'jb' }) }, users: { info: async () => ({ user: { id: 'U_JULIAN', name: 'jb', profile: { display_name: 'jb', real_name: 'Julian' } } }) } }

function setup(options: { can?: Parameters<typeof vercelProject>[0]['can']; channels?: Parameters<typeof slack>[0]['channels']; middleware?: Middleware[]; users?: UserTokens } = {}) {
  const queue = fakeQueue()
  // With people's tokens, Slack runs calls with one through `withBotToken`.
  const s = fakePlatform('slack', options.users ? (adapter) => void Object.assign(adapter, { withBotToken: <T>(_token: string, fn: () => T) => fn(), webClient: juliansSlack }) : undefined)
  let project: ReturnType<typeof board>
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url.startsWith(BOARD_URL)) return team.fetch(request)
    if (request.url.startsWith(SUPPORT_URL)) return project.fetch(request)
    return Promise.resolve(new Response('no such host', { status: 502 }))
  }
  const team = testBoard({
    scheduler: queue.scheduler,
    access: [vercelProject({ project: 'prj_support', can: options.can ?? 'all' })],
    transport: { post: (url, init) => route(url, { method: 'POST', headers: init.headers, body: init.body }) },
  })
  const backend = http(BOARD_URL, { fetch: bearer(route, supportToken) })
  project = board({
    backend,
    url: SUPPORT_URL,
    // People sign in to it as to the team's: the same project, the same principals.
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    auth: testAuth,
    sync: {
      slack: slack({
        adapter: options.users ? withUserTokens(s.adapter, options.users) : s.adapter,
        ...(options.users ? { client: async () => juliansSlack as never } : {}),
        channels: options.channels ?? { C1: 'firehose' },
      }),
    },
    ...(options.middleware ? { middleware: options.middleware } : {}),
  })
  const webhook = (body: unknown) =>
    project.fetch(new Request(`${SUPPORT_URL}/webhooks/slack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { team, project, backend, s, webhook, queue }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>, audience?: string) =>
  caller(fetch, await personToken('u_julian', audience), { 'x-board-handle': 'julian' })

const read = async (call: ReturnType<typeof caller>, channel: string) => (await call('GET', `/messages?channel=${channel}`)).body.messages as Read[]

describe('sync on a board on http()', () => {
  it("imports a webhook onto the board it uses, as the Slack author, with the message's origin", async () => {
    const { team, webhook } = setup()
    const julian = await julianOn(team.fetch)
    expect((await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    expect(root).toMatchObject({ text: 'export is broken', from: 'slack', by: { actor: 'slack:user:U_ADA' }, origin: { thread: 'slack:C1:100', message: '100' } })

    // A reply in the Slack thread lands in the board thread, and Slack's retry of it doesn't land twice.
    const reply = { type: 'message', threadId: 'slack:C1:100', id: '101', text: 'same here', user: 'U_BOB' }
    await webhook(reply)
    await webhook(reply)
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root!.id}`)).body.replies.map((r: Read) => [r.text, r.by.actor])).toEqual([['same here', 'slack:user:U_BOB']]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await julian('GET', `/messages/${root!.id}`)).body.replies).toHaveLength(1)
    // What it pushed is in the inbox there, once each, for whoever may sync everywhere.
    const { body } = await julian('GET', '/inbox/slack')
    expect(body.events.map((event: { channel: string; event: { message: string } }) => `${event.channel}|${event.event.message}`).sort()).toEqual(['slack:C1|100', 'slack:C1|101'])
  })

  it("delivers a post on the board it uses to Slack, and records the delivery's receipt there", async () => {
    const { team, backend, s } = setup()
    await backend.registerWatchers()
    const julian = await julianOn(team.fetch)
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })).body.message
    await vi.waitFor(() => expect(s.channelPosts.map((post) => [post.channelId, post.text])).toEqual([['slack:C1', JSON.stringify({ markdown: '**julian**: deploy failed' })]]))
    const receipt = async (id: string) =>
      ((await julian('GET', '/events?after=0&all=true')).body.events as { type: string; payload: { id?: string; target?: string; external?: { message: string } } }[]).find(
        (event) => event.type === 'message.synced' && event.payload.id === id,
      )
    await vi.waitFor(async () => expect(await receipt(root.id)).toMatchObject({ payload: { target: 'slack:C1', external: { message: s.channelPosts[0]!.id } } }))

    // A reply follows it into its Slack thread.
    const reply = (await julian('POST', '/messages', { re: root.id, text: 'rolled back' })).body.message
    await vi.waitFor(() => expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([[`slack:C1:${s.channelPosts[0]!.id}`, JSON.stringify({ markdown: '**julian**: rolled back' })]]))
    await vi.waitFor(async () => expect(await receipt(reply.id)).toBeDefined())
  })

  it('follows edits and reactions both ways', async () => {
    const { team, backend, s, webhook } = setup()
    await backend.registerWatchers()
    const julian = await julianOn(team.fetch)
    // From Slack: a message, then its edit and a reaction.
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await webhook({ type: 'edit', threadId: 'slack:C1:100', id: '100', text: 'export is broken on Safari', user: 'U_ADA' })
    await webhook({ type: 'reaction', threadId: 'slack:C1:100', messageId: '100', emoji: 'eyes', added: true, user: 'U_BOB' })
    await vi.waitFor(async () => expect((await read(julian, 'firehose'))[0]).toMatchObject({ text: 'export is broken on Safari', reactions: { eyes: ['slack:user:U_BOB'] } }))

    // From the board: a reply, then its edit and a reaction on it.
    const [root] = await read(julian, 'firehose')
    const reply = (await julian('POST', '/messages', { re: root!.id, text: 'looking' })).body.message
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    await julian('POST', `/messages/${reply.id}/edit`, { text: 'looking into it' })
    await julian('POST', `/messages/${reply.id}/reactions`, { emoji: 'rocket' })
    await vi.waitFor(() => expect(s.edits.map((edit) => [edit.messageId, edit.text])).toEqual([[s.posts[0]!.id, JSON.stringify({ markdown: '**julian**: looking into it' })]]))
    await vi.waitFor(() => expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: s.posts[0]!.id, emoji: 'rocket', added: true }]))
  })

  it('links a Slack account through a code from the board it uses, which its registration tells of the entry', async () => {
    const { team, backend, webhook, s } = setup()
    const here = await julianOn(team.fetch)
    // The team's board knows the project syncs Slack from its registration, and says so.
    await backend.registerWatchers()
    expect((await (await team.fetch(new Request(BOARD_URL))).json()).sync).toEqual([{ key: 'slack', platform: 'slack' }])
    // The code comes from the board that keeps the log, for the person asking: the project's entry signs no one in.
    const challenge = (await here('POST', '/sync/codes', { sync: 'slack' })).body
    expect(challenge).toEqual({ code: expect.stringMatching(/^vb-[A-Z2-9]{4}-[A-Z2-9]{4}$/), expiresAt: expect.any(String) })
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: challenge.code, user: 'U_JULIAN', name: 'jb' })
    await vi.waitFor(async () => expect((await here('GET', '/identity')).body.links).toEqual([expect.objectContaining({ actor: 'slack:user:U_JULIAN', method: 'code' })]))
    // The code was claimed, not imported, and Slack shows it worked.
    expect(await read(here, 'firehose')).toEqual([])
    expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: '100', emoji: 'check', added: true }])
  })

  it("lands a callback's own writes on the board it uses, as the Slack user its event came from", async () => {
    const seen: string[] = []
    const { team, webhook, s } = setup({
      channels: {
        C1: {
          channel: 'firehose',
          run: async ({ event, board }) => {
            if (event.kind !== 'message') return
            const { root } = await board.sync('firehose', event)
            // Its reads are sync's own, and its writes are Ada's.
            seen.push((await board.thread(root!)).message.text)
            const ack = await board.reply(root!, 'Thanks! Tracking it.')
            await board.label(root!, { set: { triaged: 'yes' } })
            await board.react(root!, 'eyes')
            await board.edit(ack.id, 'Thanks! Tracking it now.')
          },
        },
      },
    })
    const julian = await julianOn(team.fetch)
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(async () => {
      const [root] = await read(julian, 'firehose')
      expect(root).toMatchObject({ labels: { triaged: 'yes' }, reactions: { eyes: ['slack:user:U_ADA'] } })
      const { body } = await julian('GET', `/messages/${root!.id}`)
      expect(body.replies.map((reply: Read) => [reply.text, reply.by.actor, reply.from])).toEqual([['Thanks! Tracking it now.', 'slack:user:U_ADA', null]])
    })
    expect(seen).toEqual(['export is broken'])
    const labeled = ((await julian('GET', '/events?after=0')).body.events as { type: string; actor?: { id: string } }[]).find((event) => event.type === 'labels.changed')
    expect(labeled?.actor?.id).toBe('slack:user:U_ADA')
    // Written on the board as Ada, the reply goes back to her Slack thread, as one a person wrote would.
    await vi.waitFor(() => expect(s.posts.map((post) => [post.threadId, post.text])).toEqual([['slack:C1:100', JSON.stringify({ markdown: '**U_ADA**: Thanks! Tracking it.' })]]))
  })

  it('runs its middleware once on a retried post from its own code, however the middleware would answer again', async () => {
    let calls = 0
    const { team, project } = setup({ middleware: [async ({ next }) => (calls++ === 0 ? next() : undefined)] })
    const julian = await julianOn(team.fetch)
    const first = await project.as('deploys').post('firehose', { text: 'a1b2c3 is live', id: 'd1' })
    const again = await project.as('deploys').post('firehose', { text: 'a1b2c3 is live', id: 'd1' })
    expect(again.id).toBe(first.id)
    expect(calls).toBe(1)
    expect((await read(julian, 'firehose')).map((m) => [m.text, m.by.actor])).toEqual([['a1b2c3 is live', `${SUPPORT}+deploys`]])
  })

  it('runs its middleware on what Slack sends, before it reaches the board it uses', async () => {
    const quiet: Middleware = async ({ write, next }) => next({ text: write.text.replace(/\s*hunter2/g, '') })
    const { team, webhook } = setup({ middleware: [quiet] })
    const julian = await julianOn(team.fetch)
    await webhook({ type: 'message', threadId: 'slack:C1:100', id: '100', text: 'the password is hunter2', user: 'U_ADA' })
    await vi.waitFor(async () => expect((await read(julian, 'firehose')).map((m) => m.text)).toEqual(['the password is']))
  })
})

describe('the sync permission', () => {
  const author = { id: 'slack:user:U_ADA', handle: 'ada', name: 'Ada', avatar: null, isBot: false }

  it("gates every sync route: a caller without it can't speak for platform users", async () => {
    const team = testBoard({ access: [vercelProject({ project: 'prj_support', can: { firehose: ['read', 'post'] } })] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'hello' })).body.message
    const event = { kind: 'message', channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1', isRoot: true, text: 'hi', context: null, author }
    for (const [method, path, body] of [
      ['POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'firehose', text: 'as Ada' }],
      ['POST', '/sync/receipts', { kind: 'message', message: root.id, target: 'slack:C1', external: { thread: 'slack:C1:1', message: '1' } }],
      ['GET', `/sync/threads/${root.thread}`],
      ['GET', '/sync/find?thread=slack:C1:1'],
      ['GET', `/sync/copies?message=${root.id}`],
      ['GET', '/sync/roots?by=vercel:user:u_julian&since=0'],
      ['POST', '/inbox/slack', { events: [{ id: '1', event, raw: {} }] }],
      ['GET', '/inbox/slack/next'],
      ['POST', '/inbox/slack/1/ack', { lease: 'l1' }],
      ['GET', '/inbox/slack'],
      ['POST', '/sync/codes', { sync: 'slack' }],
      ['POST', '/sync/accounts', { sync: 'slack', account: author, code: 'vb-AAAA-BBBB' }],
    ] as const) {
      const denied = await support(method, path, body)
      expect(denied.status, `${method} ${path}`).toBe(403)
    }
    expect(await read(julian, 'firehose')).toHaveLength(1)
    expect((await julian('GET', '/identity')).body.links).toEqual([])
  })

  it('shows a null link for an import that came without one, as every one before links did', async () => {
    const team = testBoard({ access: [vercelProject({ project: 'prj_support', can: 'all' })] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const origin = { channel: 'slack:C1', thread: 'slack:C1:1', subthread: null, message: '1', context: null }
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel: 'firehose', text: 'from before links', origin, id: 'old-1' })).status).toBe(200)
    const [message] = await read(julian, 'firehose')
    expect(message!.origin).toEqual({ ...origin, url: null })
  })

  it("lets a caller with it in another subtree import there, and not here", async () => {
    const team = testBoard({ access: [vercelProject({ project: 'prj_support', can: { 'support/': 'all', firehose: ['read'] } })] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const post = (channel: string) => support('POST', '/sync/imports', { op: 'post', author, from: 'slack', channel, text: `from Slack to ${channel}` })
    const denied = await post('firehose')
    expect([denied.status, denied.body.error.message]).toEqual([403, "this token can't sync in firehose, so it can't import there"])
    expect((await post('support/inbox')).status).toBe(200)
    expect((await read(julian, 'support/inbox')).map((m) => [m.text, m.by.actor])).toEqual([['from Slack to support/inbox', 'slack:user:U_ADA']])
    expect(await read(julian, 'firehose')).toEqual([])

    // Nor can it reply into, receipt, or look up a thread here.
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'ours' })).body.message
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'slack', re: root.id, text: 'as Ada' })).status).toBe(403)
    expect((await support('POST', '/sync/receipts', { kind: 'failed', message: root.id, target: 'slack:C1', error: 'gone' })).status).toBe(403)
    expect((await support('GET', `/sync/threads/${root.thread}`)).status).toBe(404)
  })

  it("writes only as a platform user it syncs: never as someone the board signs in", async () => {
    const team = testBoard({ access: [vercelProject({ project: 'prj_support', can: 'all' })] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    const as = (id: string, from: string | null = 'slack') =>
      support('POST', '/sync/imports', { op: 'post', author: { ...author, id }, from, channel: 'firehose', text: `as ${id}` })
    // Someone the board authenticates: a person, a deployment, a workflow, an issuer's subject, a local person, its own code.
    for (const id of ['vercel:user:u_julian', 'vercel:project:prj_board:production', 'github:repo:123456', 'oidc:gitlab.com:acme', 'local:user:julian', 'vboard:client:deploys']) {
      const denied = await as(id)
      expect([denied.status, denied.body.error.message], id).toEqual([403, `${id} is someone this board signs in, not a platform user: sync can't write as them`])
      // A callback's own writes too.
      expect((await as(id, null)).status, id).toBe(403)
    }
    // A user of another platform than the entry's, or of one it doesn't sync at all.
    expect((await as('github:user:42')).body.error.message).toBe("github:user:42 isn't a user of slack")
    expect((await as('github:user:42', null)).status).toBe(403)
    expect((await support('POST', '/sync/imports', { op: 'post', author, from: 'github', channel: 'firehose', text: 'as Ada' })).body.error.message).toBe(
      "this token doesn't sync github here: its board registers its sync entries",
    )
    // Nor link an account that isn't one.
    expect((await support('POST', '/sync/accounts', { sync: 'slack', account: { ...author, id: 'vercel:user:u_julian' }, code: 'vb-AAAA-BBBB' })).status).toBe(403)
    expect(await read(julian, 'firehose')).toEqual([])
    expect((await as('slack:user:U_ADA')).status).toBe(200)
    expect((await read(julian, 'firehose')).map((m) => m.by.actor)).toEqual(['slack:user:U_ADA'])
  })

  it("issues codes only to people, for themselves, and links an account only by one", async () => {
    const team = testBoard({ access: [vercelProject({ project: 'prj_support', can: 'all' })] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    expect((await support('POST', '/watchers', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })).status).toBe(200)
    // A sync can't get a code at all, for itself or anyone else, and there's no linking by naming someone.
    expect((await support('POST', '/sync/codes', { sync: 'slack', person: 'vercel:user:u_julian' })).body.error.message).toBe('only people link platform accounts')
    expect((await support('POST', '/sync/accounts', { sync: 'slack', account: author, person: 'vercel:user:u_julian' })).status).toBe(400)
    expect((await support('POST', '/sync/accounts', { sync: 'slack', account: author, code: 'vb-AAAA-BBBB' })).body.error.code).toBe('bad_code')
    // A person gets one for a key the board knows, and only it links an account, to them.
    expect((await julian('POST', '/sync/codes', { sync: 'nothing' })).status).toBe(404)
    const { code } = (await julian('POST', '/sync/codes', { sync: 'slack', person: 'vercel:user:u_ada' })).body
    expect((await support('POST', '/sync/accounts', { sync: 'slack', account: author, code })).body).toMatchObject({ person: 'vercel:user:u_julian', link: { actor: author.id, method: 'code' } })
    expect((await julian('GET', '/identity')).body.links.map((link: { actor: string }) => link.actor)).toEqual([author.id])
  })

  it("signs a person in where the project's sync runs, carrying a code from the board that keeps the log", async () => {
    const signedIn = new Map<string, string>()
    const users = {
      authorize: async (principal: string, options: { callback?: string } = {}) =>
        `https://connect.test/authorize?${new URLSearchParams({ subject: principal, ...(options.callback ? { callback: options.callback } : {}) })}`,
      token: async (principal: string) => signedIn.get(principal) ?? null,
    }
    const { team, project, backend } = setup({ users })
    await backend.registerWatchers()
    const julian = await julianOn(team.fetch)
    // The team's board sends the person to the project's sign-in, with a code of their own in it.
    const challenge = (await julian('POST', '/sync/codes', { sync: 'slack' })).body
    expect(challenge).toMatchObject({ code: expect.stringMatching(/^vb-/), signIn: expect.stringMatching(new RegExp(`^${SUPPORT_URL}/identity/sign-in\\?sync=slack&code=vb-`)) })
    // The project sends them to Slack as whoever the code is for, and back to itself.
    const start = await project.fetch(new Request(challenge.signIn))
    expect(start.status).toBe(302)
    const at = new URL(start.headers.get('location')!)
    expect(at.searchParams.get('subject')).toBe('vercel:user:u_julian')
    const back = at.searchParams.get('callback')!
    expect(back).toMatch(new RegExp(`^${SUPPORT_URL}/identity/signed-in\\?`))
    // Until Slack says they approved, nothing links.
    expect((await project.fetch(new Request(back))).status).toBe(409)
    signedIn.set('vercel:user:u_julian', 'xoxp-julian')
    expect(await (await project.fetch(new Request(back))).text()).toContain('Linked')
    expect((await julian('GET', '/identity')).body.links).toEqual([expect.objectContaining({ actor: 'slack:user:U_JULIAN', method: 'consent' })])
    // The code is spent: the link can't be replayed.
    expect((await project.fetch(new Request(challenge.signIn))).status).toBe(404)
  })

  it('takes provenance only on the sync routes: a post never says who it is by', async () => {
    const team = testBoard({ access: [vercelProject({ project: 'prj_support', can: 'all' })] })
    const support = caller(team.fetch, await supportToken())
    const julian = await julianOn(team.fetch)
    const posted = (await support('POST', '/messages', { channel: 'firehose', text: 'hi', author, origin: { thread: 'slack:C1:1', message: '1' }, from: 'slack' })).body.message
    expect(posted).toMatchObject({ by: { actor: SUPPORT }, from: null, origin: null })
    expect((await read(julian, 'firehose'))[0]).toMatchObject({ by: { actor: SUPPORT }, from: null })
  })
})
