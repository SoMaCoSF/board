import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiscordAdapter } from '@chat-adapter/discord'
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { createMockState } from '@chat-adapter/tests'
import { chatSdk, channels, type ChatSdkEvent, type ChatSdkOptions } from '../src/sync/chat-sdk.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'
import type { SyncUnit } from '../src/sync/fn.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

const SECRET = 'telegram-test-secret'
const GROUP = -1001234567890
const ADA = { id: 42, is_bot: false, first_name: 'Ada', username: 'ada' }
const BOT = { id: 999, is_bot: true, first_name: 'Board', username: 'board_bot' }

type Call = { method: string; body: Record<string, unknown> }

/** Telegram's Bot API, served locally: answers what the adapter asks, and records each call. */
async function botApi() {
  const calls: Call[] = []
  let next = 500
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text && request.headers['content-type']?.includes('json') ? JSON.parse(text) as Record<string, unknown> : {}
    const method = request.url!.slice(request.url!.lastIndexOf('/') + 1)
    calls.push({ method, body })
    const result = method === 'getMe' ? BOT
      : method.startsWith('send') ? { message_id: ++next, date: 1735689600, chat: { id: Number(body.chat_id), type: 'supergroup' }, from: BOT, text: textOf(body) }
      : true
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  /** The messages sent to Telegram, plain or rich, as the chat and the text. */
  const sent = () => calls.filter((call) => call.method.startsWith('send')).map((call) => ({ chat: String(call.body.chat_id), text: textOf(call.body) }))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, sent }
}
const textOf = (body: Record<string, unknown>) => String(body.text ?? (body.rich_message as { markdown?: string } | undefined)?.markdown ?? '')
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** Telegram's real adapter through `chatSdk()`, on an in-process board. */
async function setup(groups: Record<string, SyncUnit<ChatSdkEvent>>, hooks: Omit<ChatSdkOptions, 'adapter'> = {}) {
  const api = await botApi()
  const adapter = createTelegramAdapter({ botToken: 'test-token', secretToken: SECRET, mode: 'webhook', apiUrl: api.url, userName: 'board_bot' })
  const provider = chatSdk({ adapter, ...hooks }, channels(groups))
  const board = testBoard({ sync: { telegram: provider } })
  let update = 0
  /** An update as Telegram sends it, with the webhook's secret token. The same `id` is a redelivery. */
  const request = (payload: Record<string, unknown>, id = ++update) =>
    new Request(`${BOARD_URL}/webhooks/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
      body: JSON.stringify({ update_id: id, ...payload }),
    })
  const deliver = (payload: Record<string, unknown>, id?: number) => board.fetch(request(payload, id))
  const say = (messageId: number, text: string) =>
    deliver({ message: { message_id: messageId, date: 1735689600, chat: { id: GROUP, type: 'supergroup', title: 'Support' }, from: ADA, text } })
  const react = (messageId: number, change: { old: string[]; now: string[] }, date: number, id?: number) =>
    deliver({
      message_reaction: {
        chat: { id: GROUP, type: 'supergroup', title: 'Support' }, message_id: messageId, user: ADA, date,
        old_reaction: change.old.map((emoji) => ({ type: 'emoji', emoji })), new_reaction: change.now.map((emoji) => ({ type: 'emoji', emoji })),
      },
    }, id)
  return { api, board, provider, request, deliver, say, react }
}

type Read = { id: number; text: string; from: string | null; reactions: Record<string, string[]>; by: { actor: string } }
const read = async (call: ReturnType<typeof caller>, channel: string) =>
  (await call('GET', `/messages?channel=${channel}`)).body.messages as Read[]

describe('chatSdk() on a real adapter, with no hooks', () => {
  it('mirrors a Telegram group both ways', async () => {
    const { api, board, say } = await setup({ [String(GROUP)]: 'support' })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    expect((await say(10, 'export is broken')).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))
    const [root] = await read(julian, 'support')
    expect(root).toMatchObject({ text: 'export is broken', from: 'telegram', by: { actor: `telegram:user:${ADA.id}` } })

    await julian('POST', '/messages', { re: root!.id, text: 'looking into it' })
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1))
    expect(api.sent()).toEqual([{ chat: String(GROUP), text: expect.stringMatching(/julian.*looking into it/) }])
  })

  it('keeps a new board root on the board, since a group is one conversation', async () => {
    const { api, board } = await setup({ [String(GROUP)]: 'support' })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const { body } = await julian('POST', '/messages', { channel: 'support', text: 'board only' })

    const attach = await julian('POST', `/messages/${body.message.id}/sync`, { target: `telegram:${GROUP}` })
    expect(attach.status).toBe(400)
    expect(api.sent()).toEqual([])
  })

  it('knows a reaction by its webhook: a redelivery is the same reaction, a re-add is another', async () => {
    const { board, say, react } = await setup({ [String(GROUP)]: 'support' })
    const julian = caller(board.fetch, await personToken())
    await say(10, 'export is broken')
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))

    await react(10, { old: [], now: ['👍'] }, 1735689700, 100)
    await react(10, { old: [], now: ['👍'] }, 1735689700, 100) // Telegram retries it
    await react(10, { old: ['👍'], now: [] }, 1735689760)
    await react(10, { old: [], now: ['👍'] }, 1735689820) // Ada adds it again
    // Each delivery is stored before its webhook answers.
    const { body: inbox } = await julian('GET', '/inbox/telegram')
    const reactions = (inbox.events as { event: { kind: string; added: boolean } }[]).filter((record) => record.event.kind === 'reaction')
    // Two adds and a remove, in whatever order the inbox lists them.
    expect(reactions.map((record) => record.event.added).sort()).toEqual([false, true, true])
    await vi.waitFor(async () => expect((await read(julian, 'support'))[0]!.reactions).toEqual({ thumbs_up: [`telegram:user:${ADA.id}`] }))
  })

  it("lets Telegram's retry through when the board couldn't store the first delivery", async () => {
    const { provider, request } = await setup({ [String(GROUP)]: 'support' })
    const update = { message: { message_id: 10, date: 1735689600, chat: { id: GROUP, type: 'supergroup' }, from: ADA, text: 'export is broken' } }
    const stored: ReceivedEvent[] = []
    let attempts = 0
    const emit = async (received: ReceivedEvent) => {
      if (++attempts === 1) throw new Error('the board is down')
      stored.push(received)
    }

    await expect(provider.receive('telegram', request(update, 7), emit)).rejects.toThrow('the board is down')
    expect((await provider.receive('telegram', request(update, 7), emit)).status).toBe(200)
    expect(stored.map((received) => received.event.kind)).toEqual(['message'])
  })
})

describe('chatSdk() on Discord, whose reactions carry no ID', () => {
  it('keeps add, remove, and add apart, and stores each before the webhook answers', async () => {
    const adapter = createDiscordAdapter({ botToken: 'discord-token', publicKey: 'ab'.repeat(32), applicationId: '999' })
    const board = testBoard({ sync: { discord: chatSdk({ adapter }, channels({ 'G1:C1': 'support' })) } })
    const julian = caller(board.fetch, await personToken())
    // What Discord says about the reaction is the same each time; the gateway listener adds when it saw it.
    const data = { user_id: '42', channel_id: 'C1', message_id: 'M1', guild_id: 'G1', channel_type: 0, emoji: { id: null, name: '👍' }, user: { id: '42', username: 'ada' } }
    const forward = (type: 'ADD' | 'REMOVE', timestamp: number) =>
      board.fetch(new Request(`${BOARD_URL}/webhooks/discord`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-discord-gateway-token': 'discord-token' },
        body: JSON.stringify({ type: `GATEWAY_MESSAGE_REACTION_${type}`, timestamp, data }),
      }))

    for (const [type, timestamp] of [['ADD', 1735689600000], ['REMOVE', 1735689660000], ['ADD', 1735689720000], ['ADD', 1735689720000]] as const) {
      expect((await forward(type, timestamp)).status).toBe(200)
    }
    // The last is the one before it, delivered again.
    const { body: inbox } = await julian('GET', '/inbox/discord')
    const reactions = (inbox.events as { event: { kind: string; added: boolean } }[]).filter((record) => record.event.kind === 'reaction')
    // Two adds and a remove, in whatever order the inbox lists them.
    expect(reactions.map((record) => record.event.added).sort()).toEqual([false, true, true])
  })

  it("answers a forwarded reaction only once the board has stored it, though the adapter doesn't wait", async () => {
    const adapter = createDiscordAdapter({ botToken: 'discord-token', publicKey: 'ab'.repeat(32), applicationId: '999' })
    const provider = chatSdk({ adapter }, channels({ 'G1:C1': 'support' }))
    const stored: ReceivedEvent[] = []
    // A board that takes a moment to store what came in.
    const emit = async (received: ReceivedEvent) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      stored.push(received)
    }
    const data = { user_id: '42', channel_id: 'C1', message_id: 'M1', guild_id: 'G1', channel_type: 0, emoji: { id: null, name: '👍' }, user: { id: '42', username: 'ada' } }
    const response = await provider.receive('discord', new Request(`${BOARD_URL}/webhooks/discord`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-discord-gateway-token': 'discord-token' },
      body: JSON.stringify({ type: 'GATEWAY_MESSAGE_REACTION_ADD', timestamp: 1735689600000, data }),
    }), emit)
    expect(response.status).toBe(200)
    expect(stored.map((received) => received.event.kind)).toEqual(['reaction'])
  })
})

describe('chatSdk() hooks', () => {
  it("name channels and the platform where the adapter can't, under a sync function of your own", async () => {
    const { api, board, say } = await setup({
      'support group': async (sync) => {
        if (sync.direction === 'out') return sync.deliver()
        if (sync.event.kind !== 'message') return
        await sync.import('leads', { text: `${sync.event.author.name} on ${sync.event.platform}: ${sync.event.text}` })
      },
    }, { platform: 'tg', resolveChannel: async (name) => (name === 'support group' ? String(GROUP) : name) })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    await say(10, 'do you ship to Lima?')
    await vi.waitFor(async () => expect(await read(julian, 'leads')).toHaveLength(1))
    const [root] = await read(julian, 'leads')
    // The platform names it; its user is named for the sync key they came through.
    expect(root).toMatchObject({ text: 'Ada on tg: do you ship to Lima?', by: { actor: `telegram:user:${ADA.id}` } })

    await julian('POST', '/messages', { re: root!.id, text: 'we do' })
    await vi.waitFor(() => expect(api.sent()).toHaveLength(1))
    expect(api.sent()).toEqual([{ chat: String(GROUP), text: expect.stringContaining('we do') }])
  })

  it('keep Chat SDK state where you say', async () => {
    const state = createMockState()
    const { board, say } = await setup({ [String(GROUP)]: 'support' }, { state })
    const julian = caller(board.fetch, await personToken())
    await say(10, 'export is broken')
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))
    expect(state.cache.size).toBeGreaterThan(0)
  })
})
