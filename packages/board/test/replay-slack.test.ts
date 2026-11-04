import { afterEach, describe, expect, it, vi } from 'vitest'
import { replayBoard, signedSlackRequest, slackFixture, type Backend } from './replay.ts'

let unanswered: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  expect(unanswered, "Slack methods the board called that the replay doesn't answer").toEqual([])
  unanswered = []
})

const fixture = slackFixture('thread')
const event = (name: string) => fixture[name] as { event: Record<string, any> }
const ROOT = event('root').event.ts as string
const ADA = 'slack:user:U00FAKEUSER1'
const BOB = 'slack:user:U00FAKEUSER2'

describe.each<Backend>(['a2', 'vercel'])('Slack replays on %s()', (backend) => {
  async function setup() {
    const replay = await replayBoard(backend, fixture)
    unanswered = replay.unanswered
    const send = (name: string | object, retry?: { num: number; reason: string }) =>
      replay.board.fetch(signedSlackRequest(`${replay.url}/webhooks/slack`, typeof name === 'string' ? fixture[name] : name, retry))
    /** Waits for `check` to hold, letting what the webhooks queued run each time. */
    const eventually = (check: () => Promise<void> | void) =>
      vi.waitFor(async () => {
        await replay.settle()
        await check()
      }, { timeout: 5_000 })
    const firehose = async () => (await replay.board.messages({ channel: 'firehose' })).messages
    /** The board thread the Slack thread came in as, once it has. */
    const root = async () => {
      let id: string | undefined
      await eventually(async () => {
        id = (await firehose()).find((message) => message.origin?.message === ROOT)?.id
        expect(id).toBeDefined()
      })
      return id!
    }
    return { ...replay, send, eventually, firehose, root }
  }

  it("answers Slack's URL verification with its challenge", async () => {
    const { send } = await setup()
    const response = await send('urlVerification')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain((fixture.urlVerification as { challenge: string }).challenge)
  })

  it('imports a channel message as its Slack author, and a retry of its delivery once', async () => {
    const { send, eventually, firehose } = await setup()
    expect((await send('root')).status).toBe(200)
    // Slack redelivers an event it thinks timed out, with its retry headers.
    expect((await send('root', { num: 1, reason: 'http_timeout' })).status).toBe(200)
    await eventually(async () => expect(await firehose()).toHaveLength(1))
    expect((await firehose())[0]).toMatchObject({
      text: 'export is broken on prod',
      from: 'slack',
      by: { actor: ADA },
      origin: { thread: `slack:${fixture.channel}:${ROOT}`, message: ROOT },
    })
  })

  it("puts a Slack thread reply in its root's board thread, then follows its edit and its delete", async () => {
    const { board, send, eventually, root } = await setup()
    await send('root')
    const id = await root()
    await send('reply')
    await eventually(async () => expect((await board.thread(id)).replies.map((reply) => [reply.text, reply.by.actor])).toEqual([['same here, started an hour ago', BOB]]))
    await send('edit')
    await eventually(async () => expect((await board.thread(id)).replies.map((reply) => reply.text)).toEqual(['same here, started two hours ago']))
    await send('deleted')
    await eventually(async () => expect((await board.thread(id)).replies.map((reply) => reply.deleted)).toEqual([true]))
  })

  it('adds and removes a Slack reaction on the board message it came in as', async () => {
    const { board, send, eventually, root } = await setup()
    await send('root')
    const id = await root()
    await send('reactionAdded')
    await eventually(async () => expect((await board.thread(id)).message.reactions).toEqual({ eyes: [BOB] }))
    await send('reactionRemoved')
    await eventually(async () => expect((await board.thread(id)).message.reactions).toEqual({}))
  })

  it("posts a board reply in the Slack thread it came from, and knows Slack's echo of it as its own copy", async () => {
    const { board, calls, send, eventually, root } = await setup()
    await send('root')
    const id = await root()
    await board.reply(id, { text: 'looking into it' })
    let posted: { ts: string } | undefined
    await eventually(() => {
      const call = calls.find((one) => one.method === 'chat.postMessage')
      expect(call?.args).toMatchObject({ channel: fixture.channel, thread_ts: ROOT })
      expect(JSON.stringify(call?.args)).toContain('looking into it')
      posted = { ts: `1767230000.${String(calls.filter((one) => one.method === 'chat.postMessage').length).padStart(6, '0')}` }
    })
    // Slack sends the bot's own message back as an event: it's the reply's copy, not a new message.
    const echo = JSON.parse(JSON.stringify(fixture.echoTemplate).replaceAll('{{ts}}', posted!.ts))
    expect((await send(echo)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await eventually(async () => expect((await board.thread(id)).replies.map((reply) => reply.text)).toEqual(['looking into it']))
    expect(calls.filter((one) => one.method === 'chat.postMessage')).toHaveLength(1)
  })

  // Gaps the replays show: Slack's own payloads that sync doesn't handle yet.
  it.todo("imports a bot's message by its attachments' text, as Datadog and Sentry alerts post them")
})
