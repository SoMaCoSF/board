import { describe, expect, it, vi } from 'vitest'
import { getEmoji, type Adapter, type AdapterPostableMessage, type ChatInstance, type WebhookOptions } from 'chat'
import { createMockAdapter, createTestMessage } from '@chat-adapter/tests'
import { slack } from '../src/sync/slack.ts'
import { github } from '../src/sync/github.ts'
import type { BoardOptions } from '../src/server/index.ts'
import { BOARD_URL, caller, personToken, testBoard } from './harness.ts'

const textOf = (message: AdapterPostableMessage) =>
  typeof message === 'string' ? message : JSON.stringify(message)

type WebhookPayload =
  | { type: 'message'; threadId: string; id: string; text: string; user: string; name?: string; raw?: unknown }
  | { type: 'reaction'; threadId: string; messageId: string; emoji: string; added: boolean; user: string }

/** A platform adapter driven by test payloads, recording everything posted to it. */
function fakePlatform(name: 'slack' | 'github', extend: (adapter: Adapter) => void = () => {}) {
  let chat!: ChatInstance
  let next = 0
  const posts: { threadId: string; text: string; id: string }[] = []
  const channelPosts: { channelId: string; text: string; id: string }[] = []
  const reactions: { threadId: string; messageId: string; emoji: string; added: boolean }[] = []
  const author = (user: string, name = user) => ({ userId: user, userName: name, fullName: name, isBot: false, isMe: false })
  const adapter: Adapter = createMockAdapter(name, {
    name,
    userName: 'vboard',
    initialize: async (instance: ChatInstance) => {
      chat = instance
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
    handleWebhook: async (request: Request, options?: WebhookOptions) => {
      if (request.headers.get('x-github-event')) return new Response('ok')
      const body = (await request.json()) as WebhookPayload
      if (body.type === 'message')
        await chat.processMessage(
          adapter,
          body.threadId,
          createTestMessage(body.id, body.text, {
            threadId: body.threadId,
            author: author(body.user, body.name),
            ...(body.raw ? { raw: body.raw } : {}),
          }),
          options,
        )
      else
        await chat.processReaction(
          {
            adapter,
            threadId: body.threadId,
            messageId: body.messageId,
            emoji: getEmoji(body.emoji),
            rawEmoji: body.emoji,
            added: body.added,
            user: author(body.user),
            raw: { event_ts: `${next++}` },
          },
          options,
        )
      return new Response('ok')
    },
    postMessage: async (threadId: string, message: AdapterPostableMessage) => {
      const id = `m${++next}`
      posts.push({ threadId, text: textOf(message), id })
      return { id, threadId, raw: {} }
    },
    postChannelMessage: async (channelId: string, message: AdapterPostableMessage) => {
      const id = `t${++next}`
      channelPosts.push({ channelId, text: textOf(message), id })
      return { id, threadId: `${channelId}:${id}`, raw: {} }
    },
    addReaction: async (threadId: string, messageId: string, emoji: unknown) => {
      reactions.push({ threadId, messageId, emoji: String(emoji), added: true })
    },
    removeReaction: async (threadId: string, messageId: string, emoji: unknown) => {
      reactions.push({ threadId, messageId, emoji: String(emoji), added: false })
    },
  } as Partial<Adapter>)
  extend(adapter)
  return { adapter, posts, channelPosts, reactions }
}

type SlackChannels = Parameters<typeof slack>[0]['channels']

/** Gives the fake Slack adapter a Web API client, optionally behind an async bot token as with Vercel Connect. */
function withSlackClient(client: unknown, asyncToken: boolean) {
  return (adapter: Adapter) => {
    if (!asyncToken) return void Object.assign(adapter, { webClient: client })
    let token: string | undefined
    Object.defineProperty(adapter, 'webClient', {
      get: () => {
        if (!token) throw new Error('botToken is configured as an async resolver')
        return client
      },
    })
    Object.assign(adapter, {
      getToken: async () => 'xoxb-test',
      withBotToken: (bound: string, fn: () => unknown) => {
        token = bound
        try {
          return fn()
        } finally {
          token = undefined
        }
      },
    })
  }
}

function setup(
  options: {
    alerts?: SlackChannels[string]
    channels?: SlackChannels
    slackClient?: unknown
    asyncToken?: boolean
    repos?: Parameters<typeof github>[0]['repos']
    watch?: BoardOptions['watch']
  } = {},
) {
  const s = fakePlatform('slack', options.slackClient ? withSlackClient(options.slackClient, !!options.asyncToken) : undefined)
  const g = fakePlatform('github')
  const board = testBoard({
    sync: {
      slack: slack({
        adapter: s.adapter,
        channels: { C1: 'firehose', C2: 'prs', ...(options.alerts ? { C3: options.alerts } : {}), ...options.channels },
      }),
      github: github({ adapter: g.adapter, repos: options.repos ?? { 'basehub-ai/vboard': 'prs' } }),
    },
    ...(options.watch ? { watch: options.watch } : {}),
  })
  const webhook = (key: string, body: unknown, headers: Record<string, string> = {}) =>
    board.fetch(
      new Request(`${BOARD_URL}/webhooks/${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
  return { board, s, g, webhook }
}

const read = async (call: ReturnType<typeof caller>, channel: string) =>
  (await call('GET', `/messages?channel=${channel}`)).body.messages as {
    id: number
    text: string
    re: number | null
    from: string | null
    labels: Record<string, string>
    reactions: Record<string, string[]>
    by: { actor: string }
  }[]

describe('sync', () => {
  it('keeps the mentions it can resolve in platform text, and leaves the rest as text', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'hi' })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:500', id: '500', text: '@julian and @nobody, look', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))
    const messages = (await julian('GET', '/messages?channel=firehose&from=slack')).body.messages as { mentions: string[] }[]
    expect(messages[0]!.mentions).toEqual(['vercel:user:u_julian'])
  })

  it("renders mentions natively on the mentioned actor's own platform, and as names elsewhere", async () => {
    const { board, s, g, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    // ada on Slack and octo on GitHub, in a PR thread that GitHub and Slack's #C2 both carry.
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'hi', user: 'U_ADA', name: 'ada' })
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:3', id: 'c1', text: 'ptal', user: '99', name: 'octo' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId)).toContain('slack:C2'))
    const [pr] = await read(julian, 'prs')

    const reply = await julian('POST', '/messages', { re: pr!.id, text: '@ada and @[github:user:99], see `@ada` here' })
    expect(reply.body.message.mentions).toEqual(['slack:user:U_ADA', 'github:user:99'])
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    await vi.waitFor(() => expect(g.posts).toHaveLength(1))
    expect(JSON.parse(s.posts[0]!.text)).toEqual({ markdown: '**julian**: <@U_ADA> and octo, see `@ada` here' })
    expect(JSON.parse(g.posts[0]!.text)).toEqual({ markdown: '**julian**: ada and @octo, see `@ada` here' })
  })

  it("runs watchers on Slack's messages, and syncs their replies back to Slack", async () => {
    const seen: string[] = []
    const { board, s, webhook } = setup({
      watch: {
        triage: {
          tail: 'firehose --from slack',
          run: async ({ event, board }) => {
            if (event.type === 'message.posted' && event.message!.re === null)
              await board.reply(event.message!.id, 'Thanks! Tracking it.')
          },
        },
        seen: { tail: 'firehose', run: ({ event }) => void seen.push(event.type) },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.threadId)).toEqual(['slack:C1:100']))
    expect(s.posts[0]!.text).toContain('Thanks! Tracking it.')

    // The delivery receipt is bookkeeping: only `--all` shows it, and no watcher runs on it.
    const types = async (query: string) =>
      ((await julian('GET', `/events?channel=firehose&after=0${query}`)).body.events as { type: string }[]).map((e) => e.type)
    await vi.waitFor(async () => expect(await types('&all=true')).toContain('message.synced'))
    expect(await types('')).toEqual(['message.posted', 'message.posted'])
    await vi.waitFor(() => expect(seen).toEqual(['message.posted', 'message.posted']))
  })

  it('mirrors a Slack thread into the board, and board replies back into Slack', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    expect((await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '100', text: 'export is broken', user: 'U_ADA' })).status).toBe(200)
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [root] = await read(julian, 'firehose')
    expect(root).toMatchObject({ text: 'export is broken', from: 'slack', by: { actor: 'slack:user:U_ADA' } })

    await webhook('slack', { type: 'message', threadId: 'slack:C1:100', id: '101', text: 'same here', user: 'U_BOB' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(2))

    await julian('POST', '/messages', { re: root!.id, text: 'looking into it' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]).toMatchObject({ threadId: 'slack:C1:100' })
    expect(s.posts[0]!.text).toContain('looking into it')
    expect(s.channelPosts).toHaveLength(0) // a thread that came from Slack is never re-posted to its channel
  })

  it('starts a Slack thread for a board root in a mirrored channel, then follows it', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    const { body } = await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    const started = s.channelPosts[0]!
    expect(started.channelId).toBe('slack:C1')
    expect(started.text).toContain('deploy failed')

    await julian('POST', '/messages', { re: body.message.id, text: 'rolled back' })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.posts[0]!.threadId).toBe(`slack:C1:${started.id}`)

    // A Slack reply in that thread comes back to the board thread.
    await webhook('slack', { type: 'message', threadId: `slack:C1:${started.id}`, id: 'r1', text: 'thanks', user: 'U_ADA' })
    await vi.waitFor(async () =>
      expect((await julian('GET', `/messages/${body.message.id}`)).body.replies.map((m: { text: string }) => m.text)).toEqual([
        'rolled back',
        'thanks',
      ]),
    )
    expect(s.posts).toHaveLength(1) // and isn't echoed back
  })

  it('keeps `noSync` roots on the board', async () => {
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken())
    await julian('POST', '/messages', { channel: 'firehose', text: 'scratch', noSync: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(s.channelPosts).toHaveLength(0)
  })

  it('syncs reactions both ways', async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await webhook('slack', { type: 'message', threadId: 'slack:C1:200', id: '200', text: 'bug', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    const [message] = await read(julian, 'firehose')

    await julian('POST', `/messages/${message!.id}/reactions`, { emoji: 'eyes' })
    await vi.waitFor(() => expect(s.reactions).toEqual([{ threadId: 'slack:C1:200', messageId: '200', emoji: 'eyes', added: true }]))

    await webhook('slack', { type: 'reaction', threadId: 'slack:C1:200', messageId: '200', emoji: 'white_check_mark', added: true, user: 'U_ADA' })
    await vi.waitFor(async () => {
      const [after] = await read(julian, 'firehose')
      expect(after!.reactions).toMatchObject({ eyes: ['vercel:user:u_julian'], check: ['slack:user:U_ADA'] })
    })
    expect(s.reactions).toHaveLength(1) // the Slack reaction isn't echoed back
  })

  it('hands unsynced threads in a function-mapped channel to the function, once', async () => {
    const seen: string[] = []
    const { board, s, webhook } = setup({
      alerts: async ({ message, board }) => {
        seen.push(message.text)
        const project = message.text.match(/project: (\S+)/)?.[1] ?? 'unknown'
        await board.post(`alerts/${project}`, { text: message.text, sync: [message.thread] })
      },
    })
    const julian = caller(board.fetch, await personToken())
    const payload = { type: 'message', threadId: 'slack:C3:300', id: '300', text: 'TypeError in checkout, project: www', user: 'B_SENTRY' }
    await webhook('slack', payload)
    await webhook('slack', payload) // a platform retry
    await vi.waitFor(async () => expect(await read(julian, 'alerts/www')).toHaveLength(1))
    expect(seen).toHaveLength(1)
    const [root] = await read(julian, 'alerts/www')
    expect(root!.by.actor).toBe('slack:user:B_SENTRY')
    expect(s.channelPosts).toHaveLength(0) // joining a thread doesn't re-post the root

    // The thread is synced now: replies flow both ways without the function.
    await julian('POST', '/messages', { re: root!.id, text: 'on it' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.threadId)).toEqual(['slack:C3:300']))
    await webhook('slack', { type: 'message', threadId: 'slack:C3:300', id: '301', text: 'thanks', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'alerts/www')).toHaveLength(3))
    expect(seen).toHaveLength(1)
  })

  it('turns a PR into a thread with state labels, and starts a Slack thread for it', async () => {
    const { board, s, g, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const pr = (action: string, extra: Record<string, unknown> = {}) => ({
      action,
      repository: { full_name: 'basehub-ai/vboard' },
      sender: { login: 'julianbenegas', id: 42 },
      pull_request: { number: 7, title: 'Add sync', html_url: 'https://github.com/basehub-ai/vboard/pull/7', draft: false, merged: false, ...extra },
    })
    const event = (body: unknown, delivery: string) =>
      webhook('github', body, { 'x-github-event': 'pull_request', 'x-github-delivery': delivery })

    await event(pr('opened'), 'd1')
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    const [root] = await read(julian, 'prs')
    expect(root).toMatchObject({ from: 'github', labels: { pr: 'basehub-ai/vboard#7', state: 'open' } })
    expect(root!.text).toContain('PR #7: Add sync')
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId)).toEqual(['slack:C2']))

    await event(pr('closed', { merged: true }), 'd2')
    await event(pr('closed', { merged: true }), 'd2') // redelivered
    await vi.waitFor(async () => {
      const thread = (await julian('GET', `/messages/${root!.id}`)).body
      expect(thread.message.labels.state).toBe('merged')
      expect(thread.replies.map((m: { text: string }) => m.text)).toEqual(['merged by julianbenegas'])
    })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toEqual([expect.stringContaining('merged by julianbenegas')]))
    expect(g.posts).toHaveLength(0) // GitHub's own reply never goes back to GitHub
  })

  it("keeps a GitHub author's avatar when a comment arrives without one", async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    const avatar = 'https://avatars.githubusercontent.com/u/42?v=4'
    await webhook(
      'github',
      {
        action: 'opened',
        repository: { full_name: 'basehub-ai/vboard' },
        sender: { login: 'julianbenegas', id: 42, avatar_url: avatar },
        pull_request: { number: 8, title: 'Avatars', html_url: 'https://github.com/basehub-ai/vboard/pull/8', draft: false, merged: false },
      },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'a1' },
    )
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    // Chat SDK's GitHub messages carry no avatar.
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:8', id: 'c1', text: 'nice', user: '42', name: 'julianbenegas' })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(2))

    const { body } = await julian('GET', '/actors')
    expect(body.actors.find((a: { id: string }) => a.id === 'github:user:42')).toMatchObject({ avatar })
    const events = (await julian('GET', '/events?after=0&all=true')).body.events as { type: string }[]
    expect(events.filter((e) => e.type === 'actor.seen')).toHaveLength(1) // the comment didn't rewrite the author
  })

  it("sends a repo's PRs and issues to different channels", async () => {
    const { board, webhook } = setup({ repos: { 'basehub-ai/vboard': { pulls: 'prs', issues: 'issues' } } })
    const julian = caller(board.fetch, await personToken())
    const repository = { full_name: 'basehub-ai/vboard' }
    const sender = { login: 'julianbenegas', id: 42 }
    await webhook(
      'github',
      { action: 'opened', repository, sender, pull_request: { number: 9, title: 'A PR', html_url: 'https://github.com/x/pull/9', draft: false, merged: false } },
      { 'x-github-event': 'pull_request', 'x-github-delivery': 's1' },
    )
    await webhook(
      'github',
      { action: 'opened', repository, sender, issue: { number: 10, title: 'An issue', html_url: 'https://github.com/x/issues/10' } },
      { 'x-github-event': 'issues', 'x-github-delivery': 's2' },
    )
    await vi.waitFor(async () => expect((await read(julian, 'issues')).map((m) => m.text)).toEqual([expect.stringContaining('Issue #10')]))
    expect((await read(julian, 'prs')).map((m) => m.text)).toEqual([expect.stringContaining('PR #9')])

    // A comment on the issue follows it there.
    await webhook('github', { type: 'message', threadId: 'github:basehub-ai/vboard:issue:10', id: 'c2', text: 'on it', user: '42' })
    await vi.waitFor(async () => expect(await read(julian, 'issues')).toHaveLength(2))
    expect(await read(julian, 'prs')).toHaveLength(1)
  })

  it("keeps GitHub's markdown and avatars, and posts markdown to platforms", async () => {
    const { board, s, webhook } = setup()
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const table = '| Project | Status |\n| --- | --- |\n| www | Ready |'
    await webhook('github', {
      type: 'message',
      threadId: 'github:basehub-ai/vboard:3',
      id: 'c9',
      text: 'Project Status www Ready', // Chat SDK's flattened text
      user: '35613825',
      name: 'vercel[bot]',
      raw: { comment: { body: table, user: { avatar_url: 'https://avatars.githubusercontent.com/in/8329?v=4' } } },
    })
    await vi.waitFor(async () => expect(await read(julian, 'prs')).toHaveLength(1))
    expect((await read(julian, 'prs'))[0]!.text).toBe(table)
    const { body } = await julian('GET', '/actors')
    expect(body.actors.find((a: { id: string }) => a.id === 'github:user:35613825')).toMatchObject({
      avatar: 'https://avatars.githubusercontent.com/in/8329?v=4',
    })

    const { body: posted } = await julian('POST', '/messages', { channel: 'firehose', text: '**ship it**' })
    // The GitHub thread mirrored to Slack too: each starts a thread in its channel.
    await vi.waitFor(() => expect(s.channelPosts.map((p) => p.channelId).sort()).toEqual(['slack:C1', 'slack:C2']))
    expect(s.channelPosts.find((p) => p.channelId === 'slack:C1')!.text).toBe(JSON.stringify({ markdown: '**julian**: **ship it**' }))
    expect(posted.message.id).toBeGreaterThan(0)
  })

  it('attaches an existing thread to a new target and backfills it', async () => {
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'deploys', text: 'rollback in progress' })
    await julian('POST', '/messages', { re: body.message.id, text: 'db restored' })
    const attached = await julian('POST', `/messages/${body.message.id}/sync`, { target: 'slack:C9' })
    expect(attached.body).toEqual({ target: 'slack:C9', attached: true })
    await vi.waitFor(() => expect(s.posts).toHaveLength(1))
    expect(s.channelPosts.map((p) => p.channelId)).toEqual(['slack:C9'])
    expect(s.posts[0]!.text).toContain('db restored')
    const again = await julian('POST', `/messages/${body.message.id}/sync`, { target: 'slack:C9' })
    expect(again.body.attached).toBe(false)
  })

  it('skips a Slack channel name that does not resolve, and syncs the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = { list: vi.fn(async () => ({ channels: [] })), info: vi.fn(async () => ({})), join: vi.fn() }
    const { board, s, webhook } = setup({ channels: { '#missing': 'alerts' }, slackClient: { conversations } })
    const julian = caller(board.fetch, await personToken())

    await webhook('slack', { type: 'message', threadId: 'slack:C1:500', id: '500', text: 'still syncing', user: 'U_ADA' })
    await vi.waitFor(async () => expect(await read(julian, 'firehose')).toHaveLength(1))
    await julian('POST', '/messages', { channel: 'prs', text: 'and outbound too' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping #missing: no Slack channel named #missing'))
    warn.mockRestore()
  })

  it('joins mapped Slack channels by name, and says which private ones need an invite', async () => {
    // The Vercel Connect shape: the bot token resolves asynchronously.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conversations = {
      list: vi.fn(async () => ({
        channels: [
          { id: 'C9', name: 'sf-prs', is_member: false, is_private: false },
          { id: 'C8', name: 'sf-secret', is_member: false, is_private: true },
        ],
      })),
      info: vi.fn(async ({ channel }: { channel: string }) => ({ channel: { id: channel, is_member: true } })),
      join: vi.fn(async () => ({ ok: true })),
    }
    const { board, s } = setup({
      channels: { '#sf-prs': 'deploys', '#sf-secret': 'secret' },
      slackClient: { conversations },
      asyncToken: true,
    })
    const julian = caller(board.fetch, await personToken())

    await julian('POST', '/messages', { channel: 'deploys', text: 'shipped' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.channelId).toBe('slack:C9')
    expect(conversations.join).toHaveBeenCalledTimes(1)
    expect(conversations.join).toHaveBeenCalledWith({ channel: 'C9' })
    expect(conversations.list).toHaveBeenCalledTimes(1) // one listing resolves every name
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invite the app to #sf-secret'))
    warn.mockRestore()
  })

  it('finds public channels by name when the app may not list private ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'groups:read' },
    })
    const conversations = {
      list: vi.fn(async ({ types }: { types: string }) => {
        if (types.includes('private_channel')) throw missingScope
        return { channels: [{ id: 'C9', name: 'sf-prs', is_member: true }] }
      }),
      info: vi.fn(async () => {
        throw missingScope
      }),
      join: vi.fn(),
    }
    const { board, s } = setup({
      channels: { '#sf-prs': 'deploys', '#sf-secret': 'secret' },
      slackClient: { conversations },
      asyncToken: true,
    })
    const julian = caller(board.fetch, await personToken())

    await julian('POST', '/messages', { channel: 'deploys', text: 'shipped' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))
    expect(s.channelPosts[0]!.channelId).toBe('slack:C9')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no public Slack channel named #sf-secret'))
    const inbox = await julian('GET', `/inbox/slack?channel=${encodeURIComponent('#sf-secret')}`)
    expect(inbox.status).toBe(400)
    expect(inbox.body.error.message).toContain('groups:read')
    warn.mockRestore()
  })

  it('records a delivery it gives up on, and keeps syncing the thread', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { board, s } = setup()
    const julian = caller(board.fetch, await personToken())
    const { body } = await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })
    await vi.waitFor(() => expect(s.channelPosts).toHaveLength(1))

    const post = s.adapter.postMessage
    let attempts = 0
    s.adapter.postMessage = async () => {
      attempts++
      throw Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } })
    }
    const { body: failed } = await julian('POST', '/messages', { re: body.message.id, text: 'rolled back' })
    // Without a scheduler nothing retries on its own; each drain is the next attempt.
    await vi.waitFor(async () => {
      await board.servers[0]!.drain('board')
      const { body: thread } = await julian('GET', `/messages/${body.message.id}`)
      expect(thread.replies[0].undelivered).toEqual({ 'slack:C1': 'not_in_channel' })
    })
    expect(attempts).toBe(5)

    s.adapter.postMessage = post
    await julian('POST', '/messages', { re: body.message.id, text: 'fixed forward' })
    await vi.waitFor(() => expect(s.posts.map((p) => p.text)).toEqual([expect.stringContaining('fixed forward')]))
    const events = (await julian('GET', '/events?after=0')).body.events as { type: string; payload: { id?: number } }[]
    expect(events.find((e) => e.type === 'message.sync_failed')?.payload.id).toBe(failed.message.id)
    error.mockRestore()
  })

  it('shows raw platform events in the inbox', async () => {
    const { board, webhook } = setup()
    const julian = caller(board.fetch, await personToken())
    await webhook('slack', { type: 'message', threadId: 'slack:C1:400', id: '400', text: 'hello', user: 'U_ADA' })
    await webhook('slack', { type: 'message', threadId: 'slack:C7:1', id: '1', text: 'unmapped', user: 'U_ADA' })
    const { body } = await julian('GET', '/inbox/slack')
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ channel: 'slack:C1', sync: 'slack', event: { kind: 'message', text: 'hello' } })
  })
})
