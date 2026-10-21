import { createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { createSlackAdapter } from '@chat-adapter/slack'
import { afterEach, expect, it, vi } from 'vitest'
import { slack } from '../src/sync/slack.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

afterEach(() => vi.restoreAllMocks())

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

it('waits for reaction intake registered after the Slack webhook returns', async () => {
  const config = { botToken: 'xoxb-test', botUserId: 'U_BOT', signingSecret: 'test-secret' }
  const lookupStarted = gate()
  const lookup = gate()
  vi.spyOn(Object.getPrototypeOf(createSlackAdapter(config).webClient), 'apiCall').mockImplementation(async (method: unknown) => {
    if (method === 'conversations.replies') {
      lookupStarted.resolve()
      await lookup.promise
      return { ok: true, messages: [] }
    }
    if (method === 'users.info') return { ok: true, user: { id: 'U_HUMAN', name: 'ada' } }
    throw new Error(`Unexpected Slack API call: ${method}`)
  })
  const adapter = createSlackAdapter(config)
  const provider = slack({ adapter, channels: { C1: 'dev' } })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    type: 'event_callback', team_id: 'T1', event_id: 'Ev1',
    event: { type: 'reaction_added', user: 'U_HUMAN', reaction: 'squirrel',
      item: { type: 'message', channel: 'C1', ts: '100.1' }, event_ts: '102.1' },
  })
  const signature = createHmac('sha256', 'test-secret').update(`v0:${timestamp}:${body}`).digest('hex')
  const request = new Request('https://board.test/webhooks/slack', {
    method: 'POST', body, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` },
  })
  const intakeStarted = gate()
  const persist = gate()
  const received: ReceivedEvent[] = []
  let acknowledged = false
  const response = provider.receive('slack', request, async (event) => {
    intakeStarted.resolve()
    await persist.promise
    received.push(event)
  }).then(response => {
    acknowledged = true
    return response
  })
  await Promise.race([
    lookupStarted.promise,
    response.then(async response => { throw new Error(`Webhook returned ${response.status}: ${await response.text()}`) }),
  ])
  await setImmediate()
  lookup.resolve()
  await intakeStarted.promise
  await setImmediate()
  try {
    expect(acknowledged).toBe(false)
  } finally {
    persist.resolve()
    await response
  }
  expect((await response).status).toBe(200)
  expect(received).toHaveLength(1)
  expect(received[0]?.event).toMatchObject({ kind: 'reaction', added: true, emoji: 'squirrel', message: '100.1' })
})

/** A board mirroring C1 into `dev` through the real Slack adapter, whose Web API reads each thread's root from `roots`. */
async function slackBoard(roots: Record<string, unknown>) {
  const png = new Uint8Array([137, 80, 78, 71])
  const served = () => Object.assign(Readable.from([Buffer.from(png)]), { statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': '4' } })
  const config = { botToken: 'xoxb-test', botUserId: 'U_BOT', signingSecret: 'test-secret', fileTransport: async () => served() as unknown as IncomingMessage }
  const people: Record<string, { name: string; real_name: string }> = { U_ADA: { name: 'ada', real_name: 'Ada Lovelace' }, U_BOB: { name: 'bob', real_name: 'Bob' } }
  const replies: unknown[] = []
  vi.spyOn(Object.getPrototypeOf(createSlackAdapter(config).webClient), 'apiCall').mockImplementation(async (method: unknown, args: unknown) => {
    const { ts, user } = args as { ts?: string; user?: string }
    if (method === 'conversations.replies') {
      replies.push(args)
      if (roots[ts!] instanceof Error) throw roots[ts!]
      return { ok: true, messages: [roots[ts!]] }
    }
    if (method === 'conversations.info') return { ok: true, channel: { id: 'C1', is_member: true } }
    if (method === 'users.info') return { ok: true, user: { id: user, ...people[user!], profile: { real_name: people[user!]?.real_name } } }
    throw new Error(`Unexpected Slack API call: ${method}`)
  })
  const board = testBoard({ sync: { slack: slack({ adapter: createSlackAdapter(config), channels: { C1: 'dev' } }) } })
  const julian = caller(board.fetch, await personToken())
  const deliver = async (event: Record<string, unknown>) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `Ev${event.ts}`, event: { type: 'message', channel: 'C1', ...event } })
    const signature = createHmac('sha256', 'test-secret').update(`v0:${timestamp}:${body}`).digest('hex')
    const response = await board.fetch(new Request(`${BOARD_URL}/webhooks/slack`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` },
    }))
    expect(response.status).toBe(200)
  }
  type Read = { id: string; re: string | null; text: string; by: { actor: string }; attachments: { name: string }[] }
  const read = async () => ((await julian('GET', '/messages?channel=dev')).body.messages as Read[])
  return { board, deliver, read, replies }
}

const ADA_ROOT = {
  type: 'message', user: 'U_ADA', ts: '100.1', thread_ts: '100.1', reply_count: 1, text: 'export is broken, <@U_BOB> can you look?',
  files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 4, url_private: 'https://files.slack.com/files-pri/T1-F1/shot.png' }],
}

it('brings a reply in a thread from before the board in under its root, read from Slack', async () => {
  const { deliver, read, replies } = await slackBoard({
    '100.1': ADA_ROOT,
    '200.1': { type: 'message', subtype: 'bot_message', bot_id: 'B_SENTRY', username: 'Sentry', ts: '200.1', thread_ts: '200.1', reply_count: 1, text: 'TypeError in checkout' },
  })

  // "Also send to channel": a reply all the same.
  await deliver({ subtype: 'thread_broadcast', user: 'U_BOB', text: 'on it', ts: '100.2', thread_ts: '100.1' })
  await deliver({ user: 'U_ADA', text: 'only on Safari', ts: '200.2', thread_ts: '200.1' })
  await vi.waitFor(async () => expect((await read()).map((message) => message.text)).toEqual(expect.arrayContaining(['on it', 'only on Safari'])))
  const messages = await read()
  expect(messages.filter((message) => message.re === null).map((message) => message.text).sort()).toEqual(['TypeError in checkout', 'export is broken, @Bob can you look?'])
  expect(replies).toEqual([
    expect.objectContaining({ channel: 'C1', ts: '100.1', limit: 1 }),
    expect.objectContaining({ channel: 'C1', ts: '200.1', limit: 1 }),
  ])
  const ada = messages.find((message) => message.text.startsWith('export is broken'))!
  expect(ada).toMatchObject({ by: { actor: 'slack:user:U_ADA' }, attachments: [{ name: 'shot.png' }] })
  expect(messages.find((message) => message.text === 'on it')).toMatchObject({ re: ada.id, by: { actor: 'slack:user:U_BOB' } })
  const sentry = messages.find((message) => message.text === 'TypeError in checkout')!
  expect(sentry).toMatchObject({ by: { actor: 'slack:user:B_SENTRY' } })
  expect(messages.find((message) => message.text === 'only on Safari')).toMatchObject({ re: sentry.id })

  // The same message arriving live reads the same, and a root needs no fetch.
  await deliver({ ...ADA_ROOT, ts: '300.1', thread_ts: undefined, reply_count: undefined })
  await vi.waitFor(async () => expect(await read()).toHaveLength(5))
  const live = (await read()).find((message) => message.id !== ada.id && message.text === ada.text)
  expect(live).toMatchObject({ re: null, by: ada.by, attachments: [{ name: 'shot.png' }] })
  expect(replies).toHaveLength(2)

  // The recovered root is the Slack message, so its edits reach it.
  await deliver({
    subtype: 'message_changed', ts: '100.9',
    message: { ...ADA_ROOT, text: 'export is broken on Safari', edited: { user: 'U_ADA', ts: '100.9' } },
    previous_message: ADA_ROOT,
  })
  await vi.waitFor(async () => expect((await read()).find((message) => message.id === ada.id)?.text).toBe('export is broken on Safari'))
})

it("lands a reply as a root of its own when its thread's root was deleted, or Slack keeps refusing it", async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const refused = Object.assign(new Error('An API error occurred: not_in_channel'), { code: 'slack_webapi_platform_error', data: { ok: false, error: 'not_in_channel' } })
  const { board, deliver, read, replies } = await slackBoard({
    '100.1': { type: 'message', subtype: 'tombstone', user: 'USLACKBOT', hidden: true, ts: '100.1', thread_ts: '100.1', text: 'This message was deleted.' },
    '200.1': refused,
  })
  const inbox = board.servers[1]!

  await deliver({ user: 'U_BOB', text: 'what was this?', ts: '100.2', thread_ts: '100.1' })
  await deliver({ user: 'U_BOB', text: 'on it', ts: '200.2', thread_ts: '200.1' })
  await vi.waitFor(async () => {
    await board.skipHold(inbox, 'inbox:slack:C1')
    await inbox.drain('inbox:slack:C1')
    expect((await read()).map(({ text, re }) => ({ text, re })).sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      { text: 'on it', re: null },
      { text: 'what was this?', re: null },
    ])
  })
  expect(replies.filter((args) => (args as { ts: string }).ts === '100.1')).toHaveLength(1)
  expect(replies.filter((args) => (args as { ts: string }).ts === '200.1')).toHaveLength(5)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't fetch the root of slack:C1:200.1"), expect.stringContaining('not_in_channel'))
})
