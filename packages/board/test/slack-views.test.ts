import { describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { channels } from '../src/sync/fn.ts'
import { block } from '../src/contract/blocks.ts'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'
import { caller, personToken, testBoard } from './harness.ts'

const thread = 'C1:1700000000.000100'
const as = { name: 'clever-lemur via vboard-factory', avatar: 'https://cdn.example.com/lemur.png' }
const SHA = '0b29124a0b29124a0b29124a0b29124a0b29124a'
const commit = block('git-commit@1', { sha: SHA, title: 'Fix the *checkout* total\n\nIt rounded twice.' })
/** A deployment with everything Vercel's table shows. */
const web = {
  project: 'web',
  state: 'ready',
  url: 'https://web-abc.vercel.app',
  environment: 'preview',
  inspectorUrl: 'https://vercel.com/acme/web/abc',
  projectUrl: 'https://vercel.com/acme/web',
  updatedAt: '2026-11-12T21:30:00Z',
}
/** One with only what a deployment must have, and one with a link and no environment to name it. */
const docs = { project: 'docs', state: 'building' }
const api = { project: 'api', state: 'queued', url: 'https://api-abc.vercel.app' }
const deployments = (...list: object[]) => block('vercel-deployments@1', { deployments: list })

/** What Slack shows a commit as: its short SHA and the first line of its message, small. */
const commitLine = {
  type: 'context',
  elements: [
    { type: 'mrkdwn', text: '`0b29124`' },
    { type: 'plain_text', text: 'Fix the *checkout* total', emoji: false },
  ],
}
/** The same as markdown, for where the layout can't go: the title as written, not as formatting. */
const commitMarkdown = '`0b29124` Fix the \\*checkout\\* total'
const cell = (text: string) => ({ type: 'raw_text', text })
/** A cell of formatted text. */
const rich = (...elements: unknown[]) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] })
const link = (text: string, url: string) => ({ type: 'link', text, url })
/** A state beside its color: its emoji, a space, and its name, plain or linking to the deployment's page on Vercel. */
const state = (emoji: string, name: string | { type: string }) => rich({ type: 'emoji', name: emoji }, { type: 'text', text: ' ' }, typeof name === 'string' ? { type: 'text', text: name } : name)
const HEADERS = [cell('Project'), cell('Deployment'), cell('Actions')]
/** The docs deployment's row: no page of its project's to link, none of its own, and nowhere to go. */
const docsRow = (emoji: string, name: string) => [cell('docs'), state(emoji, name), cell(' ')]

/** The real Slack adapter, kept off the network: board's own client is a fake, and so are the adapter's post and edit. */
function slackWith(scopes: string[], chat: 'all' | 'no update' | 'none' = 'all', refuses: { post?: string; update?: string } = {}) {
  const adapter = createSlackAdapter({ signingSecret: 'secret', botToken: 'xoxb-test' })
  const internals = adapter as unknown as { initialize(chat: unknown): Promise<void>; chat: unknown }
  internals.initialize = async function (chat) {
    internals.chat = chat
  }
  const viaAdapter: unknown[] = []
  adapter.postMessage = async (threadId, message) => {
    viaAdapter.push(message)
    return { id: '1700000000.000300', threadId, raw: {} }
  }
  const editsViaAdapter: unknown[] = []
  adapter.editMessage = async (threadId, id, message) => {
    editsViaAdapter.push(message)
    return { id, threadId, raw: {} }
  }
  const posted: Record<string, unknown>[] = []
  const updated: Record<string, unknown>[] = []
  const client: SlackClient = {
    conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
    ...(chat === 'none'
      ? {}
      : {
          chat: {
            postMessage: async (args) => {
              // Slack's Web API client throws what Slack answered, under `data`.
              if (refuses.post) throw Object.assign(new Error(refuses.post), { data: { error: refuses.post } })
              posted.push(args)
              return { ts: '1700000000.000200' }
            },
            ...(chat === 'all'
              ? {
                  update: async (args) => {
                    if (refuses.update) throw Object.assign(new Error(refuses.update), { data: { error: refuses.update } })
                    updated.push(args)
                  },
                }
              : {}),
          },
        }),
    auth: { test: async () => ({ response_metadata: { scopes } }) },
  }
  const provider = slack({ adapter, client: async () => client }, channels({}))
  return { provider, posted, updated, viaAdapter, editsViaAdapter }
}

describe('a block Slack has a view of', () => {
  it('shows a commit as one small line, with the text around it in its place', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const sent = await provider.post(thread, 'thread', { markdown: `pushed a **fix**\n\n${commit}\n\nmore to come` })
    expect(posted).toEqual([
      {
        channel: 'C1',
        thread_ts: '1700000000.000100',
        // What a notification shows: the text as Slack's mrkdwn, and the commit in plain words.
        text: 'pushed a *fix*\n0b29124 Fix the *checkout* total\nmore to come',
        blocks: [{ type: 'markdown', text: 'pushed a **fix**' }, commitLine, { type: 'markdown', text: 'more to come' }],
        unfurl_links: false,
        unfurl_media: false,
      },
    ])
    expect(viaAdapter).toEqual([])
    expect(sent).toEqual({ thread, message: '1700000000.000200' })
  })

  it("shows deployments as the table Vercel posts on a pull request: each project linking to its page, its state in its color linking to the deployment's, a link to it named for its environment, and how long ago", async () => {
    const { provider, posted } = slackWith(['chat:write'])
    await provider.post('C1', 'channel', { markdown: block('vercel-deployments@1', { gitSha: SHA, deployments: [web, docs, api] }) })
    await provider.post('C1', 'channel', { markdown: deployments(docs) })
    expect(posted.map((post) => [post.text, post.blocks])).toEqual([
      [
        'web: ready, docs: building, api: queued',
        [
          {
            type: 'data_table',
            caption: 'Deployments of 0b29124',
            // Slack shows five rows a page unless told: every deployment is on the first.
            page_size: 3,
            rows: [
              [...HEADERS, cell('Updated')],
              [
                rich(link('web', web.projectUrl)),
                state('large_green_circle', link('Ready', web.inspectorUrl)),
                rich(link('Preview', web.url)),
                // 2026-11-12T21:30:00Z in seconds, which Slack shows as how long ago.
                rich({ type: 'date', timestamp: Date.UTC(2026, 10, 12, 21, 30) / 1000, format: '{ago}', fallback: web.updatedAt }),
              ],
              [...docsRow('large_yellow_circle', 'Building'), cell(' ')],
              // A link with no environment to name it.
              [cell('api'), state('white_circle', 'Queued'), rich(link('Visit', api.url)), cell(' ')],
            ],
          },
        ],
      ],
      // No deployment says when: no Updated column.
      ['docs: building', [{ type: 'data_table', caption: 'Deployments', page_size: 1, rows: [HEADERS, docsRow('large_yellow_circle', 'Building')] }]],
    ])
    // A new thread: its own message is its thread.
    expect(posted[0]).not.toHaveProperty('thread_ts')
  })

  it('gives each state its color', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    const states = ['queued', 'building', 'ready', 'error', 'canceled']
    await provider.post(thread, 'thread', { markdown: deployments(...states.map((state) => ({ ...docs, state }))) })
    const [table] = posted[0]!.blocks as { page_size: number; rows: unknown[][] }[]
    expect(table!.page_size).toBe(5)
    expect(table!.rows.slice(1).map((row) => row[1])).toEqual([
      state('white_circle', 'Queued'),
      state('large_yellow_circle', 'Building'),
      state('large_green_circle', 'Ready'),
      state('red_circle', 'Error'),
      state('black_circle', 'Canceled'),
    ])
  })

  it("goes out under its author's name, the label dropped, where the app may name a sender; and as the app, label and all, where it may not", async () => {
    const markdown = `**${as.name}**: pushed\n\n${commit}`
    const named = slackWith(['chat:write', 'chat:write.customize'])
    await named.provider.post(thread, 'thread', { markdown, as })
    expect(named.posted).toEqual([expect.objectContaining({ username: as.name, icon_url: as.avatar, blocks: [{ type: 'markdown', text: 'pushed' }, commitLine] })])
    const unnamed = slackWith(['chat:write'])
    await unnamed.provider.post(thread, 'thread', { markdown, as })
    expect(unnamed.posted).toEqual([expect.objectContaining({ blocks: [{ type: 'markdown', text: `**${as.name}**: pushed` }, commitLine] })])
    expect(unnamed.posted[0]).not.toHaveProperty('username')
  })

  it('gives Slack the text around it as the adapter would, and a notification text no longer than Slack takes', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    // The Chat SDK's placeholder for an emoji, which the adapter writes as Slack's name for it.
    await provider.post(thread, 'thread', { markdown: `done {{emoji:thumbs_up}}\n\n${commit}` })
    expect(posted[0]).toMatchObject({ text: 'done :+1:\n0b29124 Fix the *checkout* total', blocks: [{ type: 'markdown', text: 'done :+1:' }, commitLine] })
    const long = 'word '.repeat(1200).trim()
    await provider.post(thread, 'thread', { markdown: `${long}\n\n${commit}` })
    const { text, blocks } = posted[1] as { text: string; blocks: unknown[] }
    // An edit's text over 4,000 characters is refused: the notification is cut, the message isn't.
    expect([text.length, text.endsWith('…'), text.startsWith('word word')]).toEqual([3900, true, true])
    expect(blocks).toEqual([{ type: 'markdown', text: long }, commitLine])
  })

  it('shows a second table as a line per deployment: Slack takes one table in a message', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    await provider.post(thread, 'thread', { markdown: `${deployments(docs)}\n\nand production:\n\n${deployments(web)}` })
    expect(posted[0]!.blocks).toEqual([
      expect.objectContaining({ type: 'data_table', page_size: 1 }),
      // What the table's row has, as markdown: its color, its links, and when, as Vercel writes it.
      { type: 'markdown', text: `and production:\n\n- 🟢 **[web](${web.projectUrl})** · [Ready](${web.inspectorUrl}) · [Preview](${web.url}) · Nov 12, 2026, 9:30 PM UTC` },
    ])
  })

  it('replaces the text and layout on an edit', async () => {
    const { provider, updated, editsViaAdapter } = slackWith(['chat:write'])
    await provider.edit(thread, '1700000000.000200', { markdown: deployments({ ...docs, state: 'error' }) })
    expect(updated).toEqual([
      {
        channel: 'C1',
        ts: '1700000000.000200',
        text: 'docs: error',
        blocks: [{ type: 'data_table', caption: 'Deployments', page_size: 1, rows: [HEADERS, docsRow('red_circle', 'Error')] }],
      },
    ])
    expect(editsViaAdapter).toEqual([])
  })
})

describe('a message that goes out as markdown, as before', () => {
  const sandbox = block('sandbox@1', { id: 'sbx-123' })
  // A commit with no title: not what `git-commit@1` holds, so Slack is shown what was written.
  const untitled = block('git-commit@1', { sha: SHA })

  it.each([
    ['has no block', 'on it'],
    ["has a block of the team's own schema", sandbox],
    ["has a block that doesn't match its built-in schema", untitled],
  ])('when it %s', async (_, markdown) => {
    const { provider, posted, updated, viaAdapter, editsViaAdapter } = slackWith(['chat:write'])
    await provider.post(thread, 'thread', { markdown })
    await provider.edit(thread, '1700000000.000200', { markdown })
    expect(viaAdapter).toEqual([{ markdown }])
    expect(editsViaAdapter).toEqual([{ markdown }])
    expect([posted, updated]).toEqual([[], []])
  })
})

describe('where the layout can not go, a view is its markdown', () => {
  /** The message as written, and as the adapter gets it: the commit as its line. */
  const written = `pushed\n\n${commit}`
  const markdown = `pushed\n\n${commitMarkdown}`

  it('with files, which go with its text', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const files = [{ data: Buffer.from('x'), filename: 'a.txt' }]
    await provider.post(thread, 'thread', { markdown: written, files })
    expect(posted).toEqual([])
    expect(viaAdapter).toEqual([{ markdown, files }])
  })

  it('with deployments, a line each: its color, its links, and nothing it has none of', async () => {
    const { provider, viaAdapter } = slackWith(['chat:write'], 'none')
    await provider.post(thread, 'thread', { markdown: deployments(docs, api, { ...docs, project: 'a_b', state: 'error' }) })
    expect(viaAdapter).toEqual([{ markdown: `- 🟡 **docs** · Building\n- ⚪ **api** · Queued · [Visit](${api.url})\n- 🔴 **a\\_b** · Error` }])
  })

  it('with more blocks than Slack takes in a message', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const fifty = Array.from({ length: 50 }, () => commit).join('\n\n')
    await provider.post(thread, 'thread', { markdown: fifty })
    expect((posted[0]!.blocks as unknown[]).length).toBe(50)
    await provider.post(thread, 'thread', { markdown: `${fifty}\n\n${commit}` })
    expect(posted).toHaveLength(1)
    expect(viaAdapter).toEqual([{ markdown: Array.from({ length: 51 }, () => commitMarkdown).join('\n\n') }])
  })

  it("when Slack won't take the layout, on a post or an edit: nothing was sent, so it isn't lost", async () => {
    for (const refusal of ['invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'block_mismatch']) {
      const { provider, viaAdapter, editsViaAdapter } = slackWith(['chat:write'], 'all', { post: refusal, update: refusal })
      const sent = await provider.post(thread, 'thread', { markdown: written })
      await provider.edit(thread, '1700000000.000200', { markdown: written })
      expect([refusal, viaAdapter, editsViaAdapter]).toEqual([refusal, [{ markdown }], [{ markdown }]])
      // The adapter's message is the one that went out.
      expect(sent).toEqual({ thread, message: '1700000000.000300' })
    }
  })

  it('but not when Slack refuses for another reason, which is the delivery failing', async () => {
    const { provider, viaAdapter, editsViaAdapter } = slackWith(['chat:write'], 'all', { post: 'channel_not_found', update: 'message_not_found' })
    await expect(provider.post(thread, 'thread', { markdown: written })).rejects.toThrow('channel_not_found')
    await expect(provider.edit(thread, '1700000000.000200', { markdown: written })).rejects.toThrow('message_not_found')
    expect([viaAdapter, editsViaAdapter]).toEqual([[], []])
  })

  it("when board has no client to post with, or one that can't edit", async () => {
    const none = slackWith(['chat:write'], 'none')
    await none.provider.post(thread, 'thread', { markdown: written })
    await none.provider.edit(thread, '1700000000.000200', { markdown: written })
    expect([none.viaAdapter, none.editsViaAdapter]).toEqual([[{ markdown }], [{ markdown }]])
    const noUpdate = slackWith(['chat:write'], 'no update')
    await noUpdate.provider.edit(thread, '1700000000.000200', { markdown: written })
    expect(noUpdate.editsViaAdapter).toEqual([{ markdown }])
  })
})

describe('a board that syncs with Slack', () => {
  it("shows a posted block's view in Slack, and its edit there too", async () => {
    const posted: Record<string, unknown>[] = []
    const updated: Record<string, unknown>[] = []
    const client = {
      conversations: { list: async () => ({}), info: async () => ({}), replies: async () => ({ messages: [] }) },
      chat: {
        postMessage: async (args: Record<string, unknown>) => (posted.push(args), { ts: `1700000000.00010${posted.length}` }),
        update: async (args: Record<string, unknown>) => void updated.push(args),
      },
      auth: { test: async () => ({ response_metadata: { scopes: ['chat:write'] } }) },
    }
    const s = fakePlatform('slack', (adapter) => {
      withSlackClient(client, false)(adapter)
      Object.assign(adapter, { decodeThreadId: (id: string) => ({ channel: id.split(':')[1], threadTs: id.split(':')[2] ?? '' }) })
    })
    const team = testBoard({ sync: { slack: slack({ adapter: s.adapter, client: async () => client as never }, channels({ C1: 'deploys' })) } })
    const julian = caller(team.fetch, await personToken('u_julian'))
    const first = await julian('POST', '/messages', { channel: 'deploys', text: deployments(docs) })
    expect(first.status).toBe(201)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const table = (emoji: string, name: string) => expect.objectContaining({ type: 'data_table', rows: [HEADERS, docsRow(emoji, name)] })
    expect(posted[0]).toMatchObject({ channel: 'C1', blocks: [expect.objectContaining({ type: 'markdown' }), table('large_yellow_circle', 'Building')] })
    expect(s.channelPosts).toEqual([])

    await julian('POST', `/messages/${first.body.message.id}/edit`, { text: deployments({ ...docs, state: 'ready' }) })
    await vi.waitFor(() => expect(updated).toHaveLength(1))
    expect(updated[0]).toMatchObject({ channel: 'C1', ts: '1700000000.000101', blocks: [expect.objectContaining({ type: 'markdown' }), table('large_green_circle', 'Ready')] })
    expect(s.edits).toEqual([])
  })
})
