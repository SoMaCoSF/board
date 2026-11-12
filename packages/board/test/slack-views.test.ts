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
const web = { url: 'https://web-abc.vercel.app', state: 'ready', project: 'web', environment: 'preview', inspectorUrl: 'https://vercel.com/acme/web/abc' }
const docs = { url: 'https://docs-abc.vercel.app', state: 'building' }

/** What Slack shows a commit as: its short SHA and the first line of its message, small. */
const commitLine = {
  type: 'context',
  elements: [
    { type: 'mrkdwn', text: '`0b29124`' },
    { type: 'plain_text', text: 'Fix the *checkout* total', emoji: false },
  ],
}
const cell = (text: string) => ({ type: 'raw_text', text })
const link = (text: string, url: string) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', text, url }] }] })

/** The real Slack adapter, kept off the network: board's own client is a fake, and so are the adapter's post and edit. */
function slackWith(scopes: string[], chat: 'all' | 'no update' | 'none' = 'all') {
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
              posted.push(args)
              return { ts: '1700000000.000200' }
            },
            ...(chat === 'all' ? { update: async (args) => void updated.push(args) } : {}),
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

  it('shows deployments as a table: a row each, its name linking to it, and a column only where one has something to say', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    await provider.post('C1', 'channel', { markdown: block('vercel-deployments@1', { gitSha: SHA, deployments: [web, docs] }) })
    await provider.post('C1', 'channel', { markdown: block('vercel-deployments@1', { deployments: [docs] }) })
    expect(posted.map((post) => [post.text, post.blocks])).toEqual([
      [
        'web: ready, docs-abc.vercel.app: building',
        [
          {
            type: 'data_table',
            caption: 'Deployments of 0b29124',
            // Slack shows five rows a page unless told: every deployment is on the first.
            page_size: 2,
            rows: [
              [cell('Deployment'), cell('State'), cell('Environment'), cell('Inspector')],
              [link('web', web.url), cell('Ready'), cell('preview'), link('Open', web.inspectorUrl)],
              [link('docs-abc.vercel.app', docs.url), cell('Building'), cell(' '), cell(' ')],
            ],
          },
        ],
      ],
      [
        'docs-abc.vercel.app: building',
        [{ type: 'data_table', caption: 'Deployments', page_size: 1, rows: [[cell('Deployment'), cell('State')], [link('docs-abc.vercel.app', docs.url), cell('Building')]] }],
      ],
    ])
    // A new thread: its own message is its thread.
    expect(posted[0]).not.toHaveProperty('thread_ts')
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

  it('keeps a second table the code block it is: Slack takes one in a message', async () => {
    const { provider, posted } = slackWith(['chat:write'])
    const second = block('vercel-deployments@1', { deployments: [web] })
    await provider.post(thread, 'thread', { markdown: `${block('vercel-deployments@1', { deployments: [docs] })}\n\n${second}` })
    expect(posted[0]!.blocks).toEqual([expect.objectContaining({ type: 'data_table', page_size: 1 }), { type: 'markdown', text: second }])
  })

  it('replaces the text and layout on an edit', async () => {
    const { provider, updated, editsViaAdapter } = slackWith(['chat:write'])
    await provider.edit(thread, '1700000000.000200', { markdown: block('vercel-deployments@1', { deployments: [{ ...docs, state: 'error' }] }) })
    expect(updated).toEqual([
      {
        channel: 'C1',
        ts: '1700000000.000200',
        text: 'docs-abc.vercel.app: error',
        blocks: [{ type: 'data_table', caption: 'Deployments', page_size: 1, rows: [[cell('Deployment'), cell('State')], [link('docs-abc.vercel.app', docs.url), cell('Error')]] }],
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

  it('when it has files, which go with its text', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write'])
    const files = [{ data: Buffer.from('x'), filename: 'a.txt' }]
    await provider.post(thread, 'thread', { markdown: commit, files })
    expect(posted).toEqual([])
    expect(viaAdapter).toEqual([{ markdown: commit, files }])
  })

  it("when board has no client to post with, or one that can't edit", async () => {
    const none = slackWith(['chat:write'], 'none')
    await none.provider.post(thread, 'thread', { markdown: commit })
    await none.provider.edit(thread, '1700000000.000200', { markdown: commit })
    expect([none.viaAdapter, none.editsViaAdapter]).toEqual([[{ markdown: commit }], [{ markdown: commit }]])
    const noUpdate = slackWith(['chat:write'], 'no update')
    await noUpdate.provider.edit(thread, '1700000000.000200', { markdown: commit })
    expect(noUpdate.editsViaAdapter).toEqual([{ markdown: commit }])
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
    const first = await julian('POST', '/messages', { channel: 'deploys', text: block('vercel-deployments@1', { deployments: [docs] }) })
    expect(first.status).toBe(201)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    const table = (state: string) => expect.objectContaining({ type: 'data_table', rows: [[cell('Deployment'), cell('State')], [link('docs-abc.vercel.app', docs.url), cell(state)]] })
    expect(posted[0]).toMatchObject({ channel: 'C1', blocks: [expect.objectContaining({ type: 'markdown' }), table('Building')] })
    expect(s.channelPosts).toEqual([])

    await julian('POST', `/messages/${first.body.message.id}/edit`, { text: block('vercel-deployments@1', { deployments: [{ ...docs, state: 'ready' }] }) })
    await vi.waitFor(() => expect(updated).toHaveLength(1))
    expect(updated[0]).toMatchObject({ channel: 'C1', ts: '1700000000.000101', blocks: [expect.objectContaining({ type: 'markdown' }), table('Ready')] })
    expect(s.edits).toEqual([])
  })
})
