import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ChatSyncProvider, type ChatInput } from '../src/sync/chat-provider.ts'
import { SyncProvider, type ProviderPost, type Receive, type ResolvedTarget, type SyncContext, type SyncHandler } from '../src/sync/provider.ts'
import { envelope, eventSchema, type SyncResult } from '../src/sync/events.ts'
import { fakePlatform } from './sync-fixtures.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

const channel = 'https://provider.test/team:inbox'
const thread = `${channel}:conversation:1`
const Schema = eventSchema('opaque', 'message')
type Event = z.infer<typeof Schema>
type Input = { id: string; kind: 'message'; text: string } | { id: string; kind: 'reaction'; added: boolean }
type Post = { target: string; kind: ResolvedTarget['kind']; body: ProviderPost }
type Options = { starts?: boolean; failCallback?: boolean; failDelivery?: boolean }

const resolve = (target: string): ResolvedTarget => ({
  target: target === 'inbox' ? channel : target, channel,
  kind: target === 'inbox' || target === channel ? 'channel' : 'thread',
})
const author = { id: 'opaque:tenant:sample:user:42', handle: 'ada', name: 'Ada', avatar: null, isBot: false }

class NativeProvider extends SyncProvider<Event> {
  posts: Post[] = []
  attempts = 0
  private readonly failDelivery: boolean

  constructor(run: SyncHandler<Event>, options: Options) {
    super({ platform: 'opaque', canStartThreads: options.starts ?? true })
    this.failDelivery = options.failDelivery ?? false
    this.map('inbox', { channel: 'tickets', run })
  }

  override async receive(key: string, request: Request, emit: Receive) {
    if (request.headers.get('x-native-signature') !== 'valid') return new Response('invalid signature', { status: 401 })
    const input = await request.json() as Input
    const location = { channel: `${key}:${channel}`, thread: `${key}:${thread}`, subthread: null }
    await emit({ dedupe: input.id, raw: input, event: input.kind === 'message'
      ? { kind: 'message', ...location, message: input.id, text: input.text, isRoot: true, context: null, author }
      : { kind: 'reaction', ...location, message: 'root', emoji: 'eyes', added: input.added, author },
    })
    return new Response('ok')
  }

  override async resolveChannel() { return channel }
  override async resolveTarget(target: string) { return resolve(target) }
  override async post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost) {
    if (++this.attempts === 1 && this.failDelivery) throw new Error('temporary delivery failure')
    this.posts.push({ target, kind, body })
    return { thread: kind === 'channel' ? `${target}:conversation:${this.posts.length}` : target, message: `sent:${this.posts.length}` }
  }
  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>) {
    return Schema.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}

class OpaqueChatProvider extends ChatSyncProvider<Event> {
  constructor(adapter: ReturnType<typeof fakePlatform>['adapter'], run: SyncHandler<Event>, options: Options) {
    super({
      platform: 'opaque', adapter, canStartThreads: options.starts ?? true,
      author: () => author, resolveChannel: async () => channel,
      resolveTarget: async (target) => resolve(target), channelOf: () => channel,
    })
    this.map('inbox', { channel: 'tickets', run })
  }

  override eventId(key: string, input: ChatInput) {
    const raw = input.kind === 'reaction' ? input.reaction.raw : input.kind === 'deleted' ? input.raw : input.message.raw
    return z.object({ delivery_id: z.string() }).parse(raw).delivery_id
  }
  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>) {
    return Schema.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}

function nativeFixture(run: SyncHandler<Event>, options: Options) {
  const provider = new NativeProvider(run, options)
  return { provider, posts: provider.posts, payload: (input: Input) => input, attempts: () => provider.attempts }
}

function chatFixture(run: SyncHandler<Event>, options: Options) {
  const fake = fakePlatform('opaque')
  const posts: Post[] = []
  let attempts = 0
  const post = fake.adapter.postMessage.bind(fake.adapter)
  fake.adapter.postMessage = async (id, body) => {
    if (++attempts === 1 && options.failDelivery) throw new Error('temporary delivery failure')
    posts.push({ target: id.slice('opaque:'.length), kind: 'thread', body: body as ProviderPost })
    return post(id, body)
  }
  const channelPost = fake.adapter.postChannelMessage!.bind(fake.adapter)
  fake.adapter.postChannelMessage = async (id, body) => {
    posts.push({ target: id.slice('opaque:'.length), kind: 'channel', body: body as ProviderPost })
    return channelPost(id, body)
  }
  const receive = fake.adapter.handleWebhook.bind(fake.adapter)
  fake.adapter.handleWebhook = (request, options) => request.headers.get('x-native-signature') === 'valid'
    ? receive(request, options) : Promise.resolve(new Response('invalid signature', { status: 401 }))
  const payload = (input: Input) => input.kind === 'message'
    ? { type: 'message', threadId: `opaque:${thread}`, id: input.id, text: input.text, user: '42', raw: { delivery_id: input.id } }
    : { type: 'reaction', threadId: `opaque:${thread}`, messageId: 'root', emoji: 'eyes', added: input.added, user: '42', raw: { delivery_id: input.id } }
  return { provider: new OpaqueChatProvider(fake.adapter, run, options), posts, payload, attempts: () => attempts }
}

function providerContract(name: string, fixture: typeof nativeFixture | typeof chatFixture) {
  describe(`provider contract: ${name}`, () => {
    async function setup(options: Options = {}) {
      const events: Event[] = []
      const results: SyncResult[] = []
      const run: SyncHandler<Event> = async ({ event, board }) => {
        events.push(event)
        const result = await board.sync('tickets', event)
        results.push(result)
        if (options.failCallback) {
          await board.reply(result.root!, 'ack')
          if (events.length === 1) throw new Error('interrupted after import')
        }
      }
      const configured = fixture(run, options)
      const board = testBoard({ sync: { tickets: configured.provider } })
      const call = caller(board.fetch, await personToken())
      const send = (input: Input, signed = true) => board.fetch(new Request(`${BOARD_URL}/webhooks/tickets`, {
        method: 'POST', headers: signed ? { 'x-native-signature': 'valid' } : {}, body: JSON.stringify(configured.payload(input)),
      }))
      const read = async () => (await call('GET', '/messages?channel=tickets')).body.messages as { id: number; text: string; reactions: Record<string, string[]> }[]
      return { ...configured, board, call, send, read, events, results }
    }

    it('authenticates before admitting an event', async () => {
      const test = await setup()
      expect((await test.send({ id: 'root', kind: 'message', text: 'forged' }, false)).status).toBe(401)
      expect(test.events).toEqual([])
      expect(await test.read()).toEqual([])
      expect((await test.send({ id: 'root', kind: 'message', text: 'signed' })).status).toBe(200)
      await vi.waitFor(async () => expect((await test.read()).map((message) => message.text)).toEqual(['signed']))
    })

    it('deduplicates native deliveries and exposes durable callback IDs', async () => {
      const test = await setup()
      const root: Input = { id: 'root', kind: 'message', text: 'hello' }
      await test.send(root)
      await test.send(root)
      const reaction: Input = { id: 'r1', kind: 'reaction', added: true }
      await test.send(reaction)
      await test.send(reaction)
      await vi.waitFor(() => expect(test.events).toHaveLength(2))
      const history = await test.board.servers[1]!.session(`inbox:tickets:${channel}`).history()
      expect(history.map((event) => event.id)).toEqual(test.events.map((event) => event.id))
      expect(Object.isFrozen(test.events[0])).toBe(true)
    })

    it('isolates concurrent webhook contexts when a provider is used by two entries', async () => {
      const events: Event[] = []
      const configured = fixture(async ({ event, board }) => {
        events.push(event)
        await board.sync('tickets', event)
      }, { starts: false })
      const board = testBoard({ sync: { left: configured.provider, right: configured.provider } })
      await Promise.all(['left', 'right'].map((key) => board.fetch(new Request(`${BOARD_URL}/webhooks/${key}`, {
        method: 'POST', headers: { 'x-native-signature': 'valid' },
        body: JSON.stringify(configured.payload({ id: key, kind: 'message', text: key })),
      }))))
      await vi.waitFor(() => expect(events).toHaveLength(2))
      for (const event of events) {
        expect(event.thread).toBe(`${event.key}:${thread}`)
        if (event.kind === 'message') expect(event.text).toBe(event.key)
      }
      expect(new Set(events.map((event) => event.id)).size).toBe(2)
    })

    it('keeps distinct add/remove/add occurrences even when the final payload repeats', async () => {
      const test = await setup()
      await test.send({ id: 'root', kind: 'message', text: 'hello' })
      await test.send({ id: 'r1', kind: 'reaction', added: true })
      await test.send({ id: 'r2', kind: 'reaction', added: false })
      await test.send({ id: 'r3', kind: 'reaction', added: true })
      await test.send({ id: 'r3', kind: 'reaction', added: true })
      await vi.waitFor(() => expect(test.events.map((event) => event.type)).toEqual(['message', 'reaction.added', 'reaction.removed', 'reaction.added']))
      expect((await test.read())[0]?.reactions).toEqual({ eyes: [author.id] })
      expect(new Set(test.events.map((event) => event.id)).size).toBe(4)
    })

    it('resumes a callback after import with stable results and writes', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const test = await setup({ failCallback: true })
        await test.send({ id: 'root', kind: 'message', text: 'hello' })
        await vi.waitFor(() => expect(error).toHaveBeenCalled())
        await vi.waitFor(async () => {
          await test.board.skipHold(test.board.servers[1]!, `inbox:tickets:${channel}`)
          await test.board.servers[1]!.drain(`inbox:tickets:${channel}`)
          expect(test.results).toHaveLength(2)
          // Each pass waits for claims to clear first, so give it time under load.
        }, { timeout: 5_000 })
        expect(test.results[1]).toEqual(test.results[0])
        expect(test.events[1]?.id).toBe(test.events[0]?.id)
        expect((await test.read()).map((message) => message.text)).toEqual(['hello', 'ack'])
        await vi.waitFor(() => expect(test.posts).toHaveLength(1))
      } finally { error.mockRestore() }
    })

    it('routes opaque destinations and records delivery receipts after retry', async () => {
      const test = await setup({ failDelivery: true })
      await test.send({ id: 'root', kind: 'message', text: 'hello' })
      await vi.waitFor(() => expect(test.results).toHaveLength(1))
      const reply = await test.call('POST', '/messages', { re: test.results[0]!.root, text: 'outgoing' })
      await vi.waitFor(() => expect(test.attempts()).toBe(1))
      await vi.waitFor(async () => {
        await test.board.skipHold(test.board.servers[0]!, 'board')
        await test.board.servers[0]!.drain('board')
        expect(test.posts).toHaveLength(1)
      })
      expect(test.posts[0]).toMatchObject({ target: thread, kind: 'thread' })
      await vi.waitFor(async () => {
        const history = await test.board.servers[0]!.session('board').history()
        expect(history.filter((event) => event.type === 'message.synced' && event.payload.id === reply.body.message.id)).toHaveLength(1)
      })
    })

    it('starts threads through static reverse routing', async () => {
      const test = await setup()
      await test.call('POST', '/messages', { channel: 'tickets', text: 'board root' })
      await vi.waitFor(() => expect(test.posts).toHaveLength(1))
      expect(test.posts[0]).toMatchObject({ target: channel, kind: 'channel' })
    })

    it('rejects channel creation when unsupported, while allowing thread attachment', async () => {
      const test = await setup({ starts: false })
      const root = await test.call('POST', '/messages', { channel: 'tickets', text: 'board root' })
      expect((await test.call('POST', `/messages/${root.body.message.id}/sync`, { target: 'tickets:inbox' })).status).toBe(400)
      expect(test.posts).toHaveLength(0)
      expect((await test.call('POST', `/messages/${root.body.message.id}/sync`, { target: `tickets:${thread}` })).status).toBe(200)
      await test.call('POST', '/messages', { re: root.body.message.id, text: 'reply after attachment' })
      await vi.waitFor(() => expect(test.posts).toHaveLength(1))
      expect(test.posts[0]).toMatchObject({ target: thread, kind: 'thread' })
    })

    it('keeps files visible when uploads are unsupported', async () => {
      const test = await setup()
      await test.send({ id: 'root', kind: 'message', text: 'hello' })
      await vi.waitFor(() => expect(test.results).toHaveLength(1))
      const uploaded = await test.board.fetch(new Request(`${BOARD_URL}/attachments`, {
        method: 'POST', headers: { authorization: `Bearer ${await personToken()}`, 'content-type': 'image/png', 'x-board-filename': 'proof.png' }, body: new Uint8Array([1, 2, 3]),
      }))
      const attachment = (await uploaded.json()).attachment
      await test.call('POST', '/messages', { re: test.results[0]!.root, text: 'proof', attachments: [attachment.id] })
      await vi.waitFor(() => expect(test.posts).toHaveLength(1))
      expect(test.posts[0]?.body.markdown).toContain('proof.png')
      expect(test.posts[0]?.body.files).toBeUndefined()
    })
  })
}

providerContract('native', nativeFixture)
providerContract('Chat SDK bridge', chatFixture)

describe('who a post is from', () => {
  it("gives a platform an agent's name and avatar to post under, and nothing for a person", async () => {
    const provider = new NativeProvider(async ({ event, board }) => { await board.sync('tickets', event) }, {})
    const board = testBoard({ sync: { tickets: provider } })
    const token = await personToken()
    const person = caller(board.fetch, token)
    const agent = caller(board.fetch, token, { 'x-board-profile': 'clever-lemur', 'x-board-avatar': 'https://example.com/lemur.png' })
    await person('POST', '/messages', { channel: 'tickets', text: 'from a person' })
    await vi.waitFor(() => expect(provider.posts).toHaveLength(1))
    await agent('POST', '/messages', { channel: 'tickets', text: 'from an agent' })
    await vi.waitFor(() => expect(provider.posts).toHaveLength(2))
    expect(provider.posts[0]!.body.as).toBeUndefined()
    const as = provider.posts[1]!.body.as
    expect(as).toEqual({ name: expect.stringMatching(/^clever-lemur via /), avatar: 'https://example.com/lemur.png' })
    expect(provider.posts[1]!.body.markdown).toBe(`**${as!.name}**: from an agent`)
  })

  it("gives an agent with the board's built-in avatar its person's Vercel avatar", async () => {
    const provider = new NativeProvider(async ({ event, board }) => { await board.sync('tickets', event) }, {})
    const board = testBoard({ sync: { tickets: provider } })
    const claude = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian', 'x-board-profile': 'claude' })
    // No username to go by: the handle the board made up isn't one.
    const unnamed = caller(board.fetch, await personToken('u_ada'), { 'x-board-profile': 'claude' })
    await claude('POST', '/messages', { channel: 'tickets', text: 'from claude' })
    await vi.waitFor(() => expect(provider.posts).toHaveLength(1))
    await unnamed('POST', '/messages', { channel: 'tickets', text: 'from another claude' })
    await vi.waitFor(() => expect(provider.posts).toHaveLength(2))
    expect(provider.posts[0]!.body.as).toEqual({ name: 'claude via julian', avatar: 'https://vercel.com/api/www/avatar?u=julian&s=64&format=png' })
    expect(provider.posts[1]!.body.as?.avatar).toBe(`${BOARD_URL}/avatars/claude`)
  })

  it("prefers the person's own picture to one guessed from a handle they chose", async () => {
    const provider = new NativeProvider(async ({ event, board }) => { await board.sync('tickets', event) }, {})
    const board = testBoard({ sync: { tickets: provider } })
    const token = await personToken()
    const julian = caller(board.fetch, token, { 'x-board-handle': 'jb', 'x-board-avatar': 'https://vercel.com/api/www/avatar/c275ff?s=128' })
    const claude = caller(board.fetch, token, { 'x-board-handle': 'jb', 'x-board-profile': 'claude' })
    await julian('POST', '/messages', { channel: 'tickets', text: 'from julian' })
    await vi.waitFor(() => expect(provider.posts).toHaveLength(1))
    await claude('POST', '/messages', { channel: 'tickets', text: 'from claude' })
    await vi.waitFor(() => expect(provider.posts).toHaveLength(2))
    expect(provider.posts[1]!.body.as).toEqual({ name: 'claude via jb', avatar: 'https://vercel.com/api/www/avatar/c275ff?s=128' })
  })
})

describe('email mentions a platform sends', () => {
  it('looks up only the first 10 and keeps the message, with the rest as plain text', async () => {
    const lookups: string[] = []
    class Directory extends NativeProvider {
      override async findByEmail(email: string) {
        lookups.push(email)
        return null
      }
    }
    const provider = new Directory(async ({ event, board }) => { await board.sync('tickets', event) }, {})
    const board = testBoard({ sync: { tickets: provider } })
    const call = caller(board.fetch, await personToken())
    const text = Array.from({ length: 30 }, (_, i) => `@[p${i}@vercel.com]`).join(' ')

    const delivered = await board.fetch(new Request(`${BOARD_URL}/webhooks/tickets`, {
      method: 'POST', headers: { 'x-native-signature': 'valid' }, body: JSON.stringify({ id: 'root', kind: 'message', text }),
    }))

    expect(delivered.status).toBe(200)
    await vi.waitFor(async () => expect((await call('GET', '/messages?channel=tickets')).body.messages).toHaveLength(1))
    expect(lookups).toHaveLength(10)
    const [message] = (await call('GET', '/messages?channel=tickets')).body.messages as { text: string }[]
    expect(message!.text).toBe(Array.from({ length: 30 }, (_, i) => `p${i}@vercel.com`).join(' '))
  })
})
