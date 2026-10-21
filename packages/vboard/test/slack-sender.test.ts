import { describe, expect, it, vi } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, slackIcon, withoutLabel, type SlackClient } from '../src/sync/slack.ts'

const thread = 'C1:1700000000.000100'
const as = { name: 'clever-lemur via vboard-factory', avatar: 'https://cdn.example.com/lemur.png' }
const markdown = `**${as.name}**: on it`

/** The real Slack adapter, kept off the network: vboard's own client is a fake, and so is the adapter's post. */
function slackWith(scopes: string[] | null, existing: { ts: string; username?: string }[] = []) {
  const adapter = createSlackAdapter({ signingSecret: 'secret', botToken: 'xoxb-test' })
  const internals = adapter as unknown as { initialize(chat: unknown): Promise<void>; chat: unknown }
  internals.initialize = async function (chat) {
    internals.chat = chat
  }
  const viaAdapter: { threadId: string; message: unknown }[] = []
  adapter.postMessage = async (threadId, message) => {
    viaAdapter.push({ threadId, message })
    return { id: '1700000000.000300', threadId, raw: {} }
  }
  const edits: { threadId: string; id: string; message: unknown }[] = []
  adapter.editMessage = async (threadId, id, message) => {
    edits.push({ threadId, id, message })
    return { id, threadId, raw: {} }
  }
  const posted: Record<string, unknown>[] = []
  const client: SlackClient = {
    conversations: {
      list: async () => ({}),
      info: async () => ({}),
      join: async () => ({}),
      replies: async ({ ts }) => ({ messages: existing.filter((m) => m.ts === ts) }),
    },
    chat: {
      postMessage: async (args) => {
        posted.push(args)
        return { ts: '1700000000.000200' }
      },
    },
    auth: { test: vi.fn(async () => ({ url: 'https://acme.slack.com/', ...(scopes ? { response_metadata: { scopes } } : {}) })) },
  }
  const provider = slack({ adapter, client: async () => client, channels: {} })
  return { provider, posted, viaAdapter, edits, client }
}

describe("an agent's messages in Slack", () => {
  it('go out under its own name, with its picture, and without the name repeated in the text', async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write', 'chat:write.customize'])
    const sent = await provider.post(thread, 'thread', { markdown, as })
    expect(posted).toEqual([
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '1700000000.000100',
        markdown_text: 'on it',
        username: as.name,
        icon_url: as.avatar,
      }),
    ])
    expect(viaAdapter).toEqual([])
    expect(sent).toEqual({ thread, message: '1700000000.000200', url: 'https://acme.slack.com/archives/C1/p1700000000000200?thread_ts=1700000000.000100&cid=C1' })
  })

  it('start a thread in a channel under its name', async () => {
    const { provider, posted } = slackWith(['chat:write.customize'])
    const sent = await provider.post('C1', 'channel', { markdown, as })
    expect(posted[0]).not.toHaveProperty('thread_ts')
    expect(sent).toEqual({ thread: 'C1:1700000000.000200', message: '1700000000.000200', url: 'https://acme.slack.com/archives/C1/p1700000000000200' })
  })

  it('go out as the app, label and all, when the app lacks chat:write.customize; asking Slack only once', async () => {
    const { provider, posted, viaAdapter, client } = slackWith(['chat:write'])
    const sent = await provider.post(thread, 'thread', { markdown, as })
    await provider.post(thread, 'thread', { markdown, as })
    expect(posted).toEqual([])
    expect(viaAdapter.map((p) => p.message)).toEqual([{ markdown }, { markdown }])
    expect(sent.url).toBe('https://acme.slack.com/archives/C1/p1700000000000300?thread_ts=1700000000.000100&cid=C1')
    expect(client.auth!.test).toHaveBeenCalledTimes(1)
  })

  it("keep going through the adapter for a person's messages and for files", async () => {
    const { provider, posted, viaAdapter } = slackWith(['chat:write.customize'])
    await provider.post(thread, 'thread', { markdown: '**Ada**: hi' })
    await provider.post(thread, 'thread', { markdown, as, files: [{ data: Buffer.from('x'), filename: 'a.txt' }] })
    expect(posted).toEqual([])
    expect(viaAdapter.map((p) => p.message)).toEqual([
      { markdown: '**Ada**: hi' },
      { markdown, files: [{ data: Buffer.from('x'), filename: 'a.txt' }] },
    ])
  })

  it('drop the label on an edit only when Slack shows the message under that name', async () => {
    const { provider, edits } = slackWith(['chat:write.customize'], [
      { ts: '1700000000.000200', username: as.name },
      { ts: '1700000000.000201' },
    ])
    await provider.edit(thread, '1700000000.000200', { markdown, as })
    await provider.edit(thread, '1700000000.000201', { markdown, as })
    expect(edits.map((e) => e.message)).toEqual([{ markdown: 'on it' }, { markdown }])
  })
})

describe('Slack sender details', () => {
  it('takes out just the label it opens with', () => {
    expect(withoutLabel(markdown, as.name)).toBe('on it')
    expect(withoutLabel(`hi\n${markdown}`, as.name)).toBe(`hi\n${markdown}`)
    expect(withoutLabel('**Ada**: hi', as.name)).toBe('**Ada**: hi')
    expect(withoutLabel('**a.b (x)**: hi', 'a.b (x)')).toBe('hi')
  })

  it("uses only https images Slack can show as the icon, not the board's SVG avatars", () => {
    expect(slackIcon('https://cdn.example.com/lemur.png')).toBe('https://cdn.example.com/lemur.png')
    expect(slackIcon('https://board.example.com/api/board/avatars/pi')).toBeNull()
    expect(slackIcon('https://cdn.example.com/lemur.svg')).toBeNull()
    expect(slackIcon('http://localhost/lemur.png')).toBeNull()
    expect(slackIcon(null)).toBeNull()
  })
})
