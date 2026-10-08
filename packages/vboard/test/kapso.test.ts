import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createKapsoAdapter } from '@kapso/chat-adapter'
import { memory } from 'experimental-a2/store-memory'
import { kapso } from '../src/sync/kapso.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

const SECRET = 'kapso-test-secret'
const NUMBER = '16315558151'
const JANE = '15551234567'

/** The real Kapso adapter, sending through a fake WhatsApp client that records what it sends. */
function setup(numbers: Parameters<typeof kapso>[0]['numbers'] = { [NUMBER]: 'support' }, store?: ReturnType<typeof memory>, render?: import('../src/sync/kapso.ts').KapsoOptions['render']) {
  const reads: { phoneNumberId: string; messageId: string; typingIndicator?: { type: string } }[] = []
  const texts: { phoneNumberId: string; to: string; body: string }[] = []
  const reactions: { phoneNumberId: string; to: string; reaction: { messageId: string; emoji?: string } }[] = []
  const uploads: { phoneNumberId: string; type: string; fileName: string; bytes: number }[] = []
  const images: { phoneNumberId: string; to: string; image: { id?: string; caption?: string } }[] = []
  const client = {
    isKapsoProxy: () => true,
    media: {
      download: async ({ mediaId }: { mediaId: string }) => (mediaId === 'MEDIA_1' ? PNG.buffer.slice(0) : new ArrayBuffer(0)),
      upload: async (input: { phoneNumberId: string; type: string; file: Blob; fileName: string }) => {
        uploads.push({ phoneNumberId: input.phoneNumberId, type: input.type, fileName: input.fileName, bytes: input.file.size })
        return { id: `MEDIA_UP${uploads.length}` }
      },
    },
    messages: {
      markRead: async (input: (typeof reads)[number]) => {
        reads.push(input)
        return { success: true }
      },
      sendImage: async (input: (typeof images)[number]) => {
        images.push(input)
        return { messages: [{ id: `wamid.img${images.length}` }] }
      },
      sendText: async (input: (typeof texts)[number]) => {
        texts.push(input)
        return { messages: [{ id: `wamid.out${texts.length}` }] }
      },
      sendReaction: async (input: (typeof reactions)[number]) => {
        reactions.push(input)
        return { messages: [{ id: `wamid.react${reactions.length}` }] }
      },
    },
  }
  const adapter = createKapsoAdapter({ client: client as never, webhookSecret: SECRET, phoneNumberId: NUMBER })
  const board = testBoard({ sync: { kapso: kapso({ adapter, numbers, render, markRead: (input) => client.messages.markRead(input) }) }, ...(store ? { store } : {}) })

  let next = 0
  /** A `whatsapp.message.received` delivery, signed as Kapso signs it. */
  const receive = (message: Record<string, unknown>, options: { conversation?: string; signature?: string } = {}) => {
    const body = JSON.stringify({
      message: { timestamp: String(1735689600 + next++), from: JANE, kapso: { direction: 'inbound' }, ...message },
      conversation: { id: options.conversation ?? 'conv_1', contact_name: 'Jane Doe', phone_number_id: NUMBER, status: 'active' },
      phone_number_id: NUMBER,
    })
    return board.fetch(
      new Request(`${BOARD_URL}/webhooks/kapso`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-event': 'whatsapp.message.received',
          'x-webhook-signature': options.signature ?? createHmac('sha256', SECRET).update(body).digest('hex'),
        },
        body,
      }),
    )
  }
  const text = (id: string, body: string, conversation?: string) =>
    receive({ id, type: 'text', text: { body } }, conversation ? { conversation } : {})
  const react = (id: string, target: string, emoji: string) => receive({ id, type: 'reaction', reaction: { message_id: target, emoji } })
  return { board, texts, reactions, uploads, images, reads, receive, text, react }
}

type Read = { id: number; text: string; re: number | null; from: string | null; reactions: Record<string, string[]>; by: { actor: string } }
const read = async (call: ReturnType<typeof caller>, channel: string) =>
  (await call('GET', `/messages?channel=${channel}`)).body.messages as Read[]

describe('kapso sync', () => {
  it('requires the public read operation at setup', () => {
    const adapter = createKapsoAdapter({ client: { isKapsoProxy: () => true } as never, webhookSecret: SECRET, phoneNumberId: NUMBER })
    expect(() => kapso({ adapter, numbers: {} } as unknown as import('../src/sync/kapso.ts').KapsoOptions)).toThrow('public markRead operation')
  })


  it('omits attribution without losing media-only replies or their receipts', async () => {
    const { board, text, texts, images, uploads } = setup(undefined, undefined, ({ message }) => message.text)
    const token = await personToken()
    const call = caller(board.fetch, token)
    await text('wamid.1', 'hello')
    await vi.waitFor(async () => expect(await read(call, 'support')).toHaveLength(1))
    const [root] = await read(call, 'support')
    await call('POST', '/messages', { re: root!.id, text: 'plain reply' })
    await vi.waitFor(() => expect(texts).toEqual([{ phoneNumberId: NUMBER, to: JANE, body: 'plain reply' }]))
    const upload = await board.fetch(new Request(`${BOARD_URL}/attachments`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-board-filename': 'proof.png' }, body: PNG,
    }))
    const attachment = (await upload.json()).attachment
    const posted = await call('POST', '/messages', { re: root!.id, text: '', attachments: [attachment.id] })
    await vi.waitFor(() => expect(images).toHaveLength(1))
    await vi.waitFor(async () => {
      const events = (await call('GET', '/events?after=0&all=true')).body.events
      expect(events.find((event: { type: string; payload: { id: number } }) => event.type === 'message.synced' && event.payload.id === posted.body.message.id)?.payload.external.message).toBe('wamid.img1')
      expect(events.find((event: { type: string; payload: { id: number } }) => event.type === 'message.files_synced' && event.payload.id === posted.body.message.id)?.payload.files).toEqual(['wamid.img1'])
    })
    expect(texts).toHaveLength(1)
    expect(uploads).toHaveLength(1)
  })
  it('mirrors a WhatsApp conversation into the board, and board replies back to the contact', async () => {
    const { board, texts, text } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    expect((await text('wamid.1', 'export is *broken*')).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))
    const [root] = await read(julian, 'support')
    expect(root).toMatchObject({ text: 'export is **broken**', from: 'kapso', by: { actor: `whatsapp:user:${JANE}` } })
    const { body: inbox } = await julian('GET', '/inbox/kapso')
    expect(inbox.events[0]).toMatchObject({
      channel: `kapso:${NUMBER}`,
      event: { thread: `kapso:${NUMBER}:${JANE}:conv_1`, author: { name: 'Jane Doe' } },
    })

    await text('wamid.2', 'since this morning')
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(2))

    await julian('POST', '/messages', { re: root!.id, text: 'looking **into** it' })
    await vi.waitFor(() => expect(texts).toEqual([{ phoneNumberId: NUMBER, to: JANE, body: '*julian*: looking *into* it' }]))
  })

  it('starts a thread for each Kapso conversation', async () => {
    const { board, text } = setup()
    const julian = caller(board.fetch, await personToken())
    await text('wamid.1', 'export is broken')
    await text('wamid.2', 'new question', 'conv_2')
    await vi.waitFor(async () => expect((await read(julian, 'support')).map((m) => m.re)).toEqual([null, null]))
  })

  it("rejects webhooks Kapso didn't sign", async () => {
    const { board, receive } = setup()
    const julian = caller(board.fetch, await personToken())
    const response = await receive({ id: 'wamid.1', type: 'text', text: { body: 'hi' } }, { signature: 'f00d' })
    expect(response.status).toBe(401)
    expect((await julian('GET', '/inbox/kapso')).body.events).toEqual([])
  })

  it('keeps one reaction per person on a message, as WhatsApp does', async () => {
    const { board, reactions, texts, text, react } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await text('wamid.1', 'export is broken')
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))
    const [root] = await read(julian, 'support')

    await julian('POST', `/messages/${root!.id}/reactions`, { emoji: 'eyes' })
    await vi.waitFor(() =>
      expect(reactions).toEqual([{ phoneNumberId: NUMBER, to: JANE, reaction: { messageId: 'wamid.1', emoji: '👀' } }]),
    )

    await julian('POST', '/messages', { re: root!.id, text: 'fixed' })
    await vi.waitFor(() => expect(texts).toHaveLength(1))
    const reactionsOn = async () => (await julian('GET', `/messages/${root!.id}`)).body.replies[0].reactions
    await react('wamid.r1', 'wamid.out1', '👍')
    await vi.waitFor(async () => expect(await reactionsOn()).toEqual({ thumbs_up: [`whatsapp:user:${JANE}`] }))
    await react('wamid.r2', 'wamid.out1', '❤️')
    await vi.waitFor(async () => expect(await reactionsOn()).toEqual({ heart: [`whatsapp:user:${JANE}`] }))
    await react('wamid.r3', 'wamid.out1', '') // a removal names no emoji
    await vi.waitFor(async () => expect(await reactionsOn()).toEqual({}))
    expect(reactions).toHaveLength(1) // Jane's reactions aren't echoed back
  })

  it('brings WhatsApp media onto the board as files, and sends board files to WhatsApp', async () => {
    const { board, texts, uploads, images, receive } = setup()
    const token = await personToken()
    const julian = caller(board.fetch, token, { 'x-board-handle': 'julian' })
    await receive({
      id: 'wamid.1',
      type: 'image',
      image: { id: 'MEDIA_1', caption: 'my receipt' },
      kapso: { direction: 'inbound', media_data: { content_type: 'image/png', byte_size: PNG.byteLength } },
    })
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))
    const [root] = (await read(julian, 'support')) as unknown as { id: number; text: string; attachments: { id: string; name: string; type: string }[] }[]
    expect(root).toMatchObject({ text: 'my receipt', attachments: [{ name: 'image', type: 'image/png' }] })
    const file = await board.fetch(new Request(`${BOARD_URL}/attachments/${root!.attachments[0]!.id}`, { headers: { authorization: `Bearer ${token}` } }))
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)

    // A board reply's text goes first, then each file as its own WhatsApp message.
    const uploaded = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png', 'x-board-filename': 'refund.png' },
        body: PNG,
      }),
    )
    const { attachment } = (await uploaded.json()) as { attachment: { id: string } }
    await julian('POST', '/messages', { re: root!.id, text: 'refunded, see this', attachments: [attachment.id] })
    await vi.waitFor(() => expect(images).toEqual([{ phoneNumberId: NUMBER, to: JANE, image: { id: 'MEDIA_UP1' } }]))
    expect(texts).toEqual([{ phoneNumberId: NUMBER, to: JANE, body: '*julian*: refunded, see this' }])
    expect(uploads).toEqual([{ phoneNumberId: NUMBER, type: 'image/png', fileName: 'refund.png', bytes: PNG.byteLength }])
  })

  it('hands new conversations on a function-mapped number to the function, which can join them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { board, texts, text } = setup({
      '+1 631-555-8151': 'support',
      [NUMBER]: async ({ event, board }) => {
        if (event.kind !== 'message') return
        await board.sync('leads', event, { text: `${event.author.name}: ${event.text}` })
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await text('wamid.1', 'do you ship to Lima?')
    await vi.waitFor(async () => expect(await read(julian, 'leads')).toHaveLength(1))
    const [root] = await read(julian, 'leads')
    expect(root!.text).toBe('Jane Doe: do you ship to Lima?')

    await julian('POST', '/messages', { re: root!.id, text: 'we do' })
    await vi.waitFor(() => expect(texts.map((t) => t.to)).toEqual([JANE]))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("+1 631-555-8151 isn't a phone number ID"))
    warn.mockRestore()
  })
  it('shows typing on WhatsApp, marking the latest inbound message read', async () => {
    const { board, reads, text } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await text('wamid.1', 'export is broken')
    await text('wamid.2', 'since this morning')
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(2))
    const [, reply] = await read(julian, 'support')

    const before = (await julian('GET', '/channels')).body.cursor
    // Any message in the thread will do: typing is for the whole thread.
    const typed = await julian('POST', `/messages/${reply!.id}/typing`, {})
    expect(typed).toMatchObject({ status: 200, body: { targets: [`kapso:${NUMBER}:${JANE}:conv_1`] } })
    expect(reads).toEqual([{ phoneNumberId: NUMBER, messageId: 'wamid.2', typingIndicator: { type: 'text' } }])
    // Nothing is written to the log.
    expect((await julian('GET', '/channels')).body.cursor).toBe(before)
  })

  it('shows typing from a fresh instance, which never saw the inbound webhook', async () => {
    const store = memory()
    const first = setup(undefined, store)
    const julian = caller(first.board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await first.text('wamid.1', 'export is broken')
    await vi.waitFor(async () => expect(await read(julian, 'support')).toHaveLength(1))
    const [root] = await read(julian, 'support')

    // Another serverless instance: its adapter has nothing in memory.
    const second = setup(undefined, store)
    const other = caller(second.board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    expect((await other('POST', `/messages/${root!.id}/typing`, {})).status).toBe(200)
    expect(second.reads).toEqual([{ phoneNumberId: NUMBER, messageId: 'wamid.1', typingIndicator: { type: 'text' } }])
  })

  it("doesn't show typing on a thread that isn't synced", async () => {
    const { board, reads } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const { body } = await julian('POST', '/messages', { channel: 'support', text: 'board only' })
    expect(await julian('POST', `/messages/${body.message.id}/typing`, {})).toMatchObject({ status: 200, body: { targets: [] } })
    expect(reads).toEqual([])
    expect((await julian('POST', '/messages/9999/typing', {})).status).toBe(404)
  })
})
