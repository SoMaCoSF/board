// Replays of Slack's own webhook payloads through the real Slack adapter, as Chat SDK's replay tests
// do: each request is signed as Slack signs it, and only Slack's Web API is answered here, from what
// the fixture says the workspace holds. A board on a2() and one on vercel() take the same replays.
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSlackAdapter } from '@chat-adapter/slack'
import { vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { slack } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { as, fakeMessageboard } from './messageboard.ts'
import { BOARD_URL, testBoard } from './harness.ts'

export type SlackFixture = {
  botUserId: string
  teamId: string
  channel: string
  users: Record<string, { id: string; name: string; real_name: string; profile: Record<string, string> }>
  [payload: string]: unknown
}

/** A fixture file under `fixtures/replay/slack/`: recorded payloads, their IDs sanitized. */
export const slackFixture = (name: string): SlackFixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/replay/slack/${name}.json`, import.meta.url), 'utf8')) as SlackFixture

export const SLACK_SIGNING_SECRET = 'test-signing-secret'

/** A call the board made to Slack's Web API. */
export type SlackCall = { method: string; args: Record<string, any> }

/**
 * Answers Slack's Web API for the workspace a fixture describes, and records each call. A method
 * nothing answers throws, so a replay that reaches for one fails loudly instead of passing on a stub.
 */
function slackApi(fixture: SlackFixture) {
  const calls: SlackCall[] = []
  /** Methods the board called that nothing here answers: a replay that has any fails, even where sync shrugged it off. */
  const unanswered: string[] = []
  let posted = 0
  const answer = (method: string, args: Record<string, any>): Record<string, unknown> => {
    switch (method) {
      case 'auth.test':
        return { ok: true, user_id: fixture.botUserId, team_id: fixture.teamId, bot_id: 'B00FAKEBOT01', user: 'board' }
      case 'users.info': {
        const user = fixture.users[args.user as string]
        return user ? { ok: true, user } : { ok: false, error: 'user_not_found' }
      }
      case 'bots.info':
        return { ok: true, bot: { id: args.bot, name: 'bot', icons: {} } }
      case 'conversations.info':
        return { ok: true, channel: { id: args.channel, name: 'firehose', is_channel: true, is_member: true } }
      case 'conversations.list':
        return { ok: true, channels: [{ id: fixture.channel, name: 'firehose', is_channel: true, is_member: true }], response_metadata: { next_cursor: '' } }
      case 'conversations.replies':
      case 'conversations.history':
        return { ok: true, messages: [], has_more: false }
      case 'chat.getPermalink':
        return { ok: true, permalink: `https://fake.slack.com/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` }
      case 'chat.postMessage': {
        // Slack's timestamps, after the fixture's: each post its own.
        const ts = `1767230000.${String(++posted).padStart(6, '0')}`
        return { ok: true, channel: args.channel, ts, message: { ts, text: args.text, user: fixture.botUserId, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) } }
      }
      case 'chat.update':
        return { ok: true, channel: args.channel, ts: args.ts, text: args.text }
      case 'chat.delete':
        return { ok: true, channel: args.channel, ts: args.ts }
      case 'reactions.add':
      case 'reactions.remove':
        return { ok: true }
      default:
        unanswered.push(method)
        throw new Error(`replay: nothing answers Slack's ${method}`)
    }
  }
  const config = { botToken: 'xoxb-test', botUserId: fixture.botUserId, signingSecret: SLACK_SIGNING_SECRET }
  // A WebClient binds its methods (`users.info`, …) to `apiCall` when it's made: the stub goes on
  // the prototype first, then the adapter that's replayed is made, so none of its calls reach Slack.
  const prototype = Object.getPrototypeOf((createSlackAdapter(config) as unknown as { webClient: object }).webClient)
  vi.spyOn(prototype, 'apiCall').mockImplementation(async (method: unknown, args: unknown) => {
    const call = { method: String(method), args: (args ?? {}) as Record<string, any> }
    calls.push(call)
    return answer(call.method, call.args)
  })
  return { adapter: createSlackAdapter(config), calls, unanswered }
}

/** A Slack webhook request, signed as Slack signs it, with Slack's retry headers on a redelivery. */
export function signedSlackRequest(url: string, payload: unknown, retry?: { num: number; reason: string }): Request {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')
  return new Request(url, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${signature}`,
      ...(retry ? { 'x-slack-retry-num': String(retry.num), 'x-slack-retry-reason': retry.reason } : {}),
    },
  })
}

export type Backend = 'a2' | 'vercel'

/**
 * A board syncing the fixture's channel with `firehose`, on `backend`. `settle` lets what a
 * webhook queued run: nothing on a2(), whose sync runs in-process, and a wake-up on vercel(), as
 * the API would send. `board` reads and writes as the board's own code.
 */
export async function replayBoard(backend: Backend, fixture: SlackFixture) {
  const { adapter, calls, unanswered } = slackApi(fixture)
  const sync = { slack: slack({ adapter }, channels({ [fixture.channel]: 'firehose' })) }
  if (backend === 'a2') {
    const created = testBoard({ sync })
    return { board: created, calls, unanswered, url: BOARD_URL, settle: async () => {} }
  }
  const url = 'https://pong.example/api/board'
  const api = fakeMessageboard()
  const created = board({
    backend: vercel({ team: 'team_test', api: 'http://localhost', fetch: as(api, 'project:prj_pong:production'), files: api.files }),
    url,
    basePath: '/api/board',
    sync,
  })
  // It registers its sync entry, which claims the key, before any webhook comes in.
  await created.me()
  await vi.waitFor(() => {
    if (!api.registrations.get('vercel:project:prj_pong:production')?.sync.length) throw new Error('not registered yet')
  })
  return { board: created, calls, unanswered, url, api, settle: () => created.fetch(new Request(`${url}/wake`, { method: 'POST' })).then(() => undefined) }
}
