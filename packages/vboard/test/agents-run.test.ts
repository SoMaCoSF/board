import { tool, type ToolSet, type UIMessage, type UIMessageChunk } from 'ai'
import { agent } from 'experimental-a2/ai/server'
import type { AISDKHarness } from 'experimental-a2/ai/server'
import { memory } from 'experimental-a2/store-memory'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { MessageView, NotificationView } from '../src/api/routes.ts'
import type { AgentConfig, AgentRunContext } from '../src/server/agents.ts'
import { vb } from '../src/tools/index.ts'
import { caller, deploymentToken, personToken, PROJECT_ID, testBoard } from './harness.ts'

type Call = { tool?: string; command?: string; input?: unknown }
type Turn = { wake: string; outputs: string[] }

/**
 * A model that makes the tool calls `script` returns, one step at a time: it sees the wakeup and what
 * its calls printed so far, and stops when it returns none.
 */
function scripted(script: (turn: Turn) => Call[] | Promise<Call[]>, options: { callIds?: (n: number) => string } = {}) {
  const wakes: string[] = []
  const harness: AISDKHarness = {
    type: 'ai-sdk',
    compaction: false,
    generate: async ({ event, messages }) => {
      const id = (event.payload as { responseMessageId: string }).responseMessageId
      const user = messages.findLastIndex((m: UIMessage) => m.role === 'user')
      const wake = messages[user]!.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      const outputs = messages
        .slice(user + 1)
        .flatMap((m: UIMessage) => m.parts)
        .flatMap((p) => (p.type.startsWith('tool-') && 'output' in p && typeof p.output === 'string' ? [p.output] : []))
      if (outputs.length === 0 && !messages.slice(user + 1).some((m: UIMessage) => m.parts.some((p) => p.type.startsWith('tool-')))) wakes.push(wake)
      const calls = await script({ wake, outputs })
      const chunks: UIMessageChunk[] =
        calls.length === 0
          ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }]
          : calls.map((call, n) => ({
              type: 'tool-input-available',
              toolCallId: options.callIds?.(n) ?? `${id}-${outputs.length}-${n}`,
              toolName: call.tool ?? 'vb',
              input: call.input ?? { command: call.command },
            }))
      return new ReadableStream({
        start(controller) {
          // A step that calls tools says so, or A2 takes it as the end of the turn.
          const finish = { type: 'finish', finishReason: calls.length > 0 ? 'tool-calls' : 'stop' }
          for (const chunk of [{ type: 'start', messageId: id }, { type: 'start-step' }, ...chunks, { type: 'finish-step' }, finish] as UIMessageChunk[])
            controller.enqueue(chunk)
          controller.close()
        },
      })
    },
  }
  return { harness, wakes }
}

const lines = (output: string) => output.split('\n').filter(Boolean).map((line) => JSON.parse(line) as NotificationView)

/** Reads its notifications, then answers `text` in each thread they're from. */
const answering =
  (text: string) =>
  ({ outputs }: Turn): Call[] => {
    if (outputs.length === 0) return [{ command: 'notifications --json' }]
    if (outputs.length === 1) return [...new Set(lines(outputs[0]!).map((n) => n.thread))].map((thread) => ({ command: `reply ${thread} "${text}"` }))
    return []
  }

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

async function setup(script: (turn: Turn) => Call[] | Promise<Call[]>, config: Omit<AgentConfig, 'run'> = {}, tools: ToolSet = {}) {
  const model = scripted(script)
  const store = memory()
  const helper = agent({ name: 'helper', store, model: 'test/model', maxSteps: 8, tools: { vb, ...tools }, harness: model.harness })
  const board = testBoard({ store, agents: { helper: { ...config, run: helper } } })
  const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
  const thread = async (id: number) => (await julian('GET', `/messages/${id}`)).body as { message: MessageView; replies: MessageView[] }
  const post = async (body: Record<string, unknown>) => (await julian('POST', '/messages', body)).body.message as MessageView
  return { model, board, julian, thread, post }
}

describe('agents the board runs', () => {
  it('wake with "you have N new notifications", never their text, and answer through vb as themselves', async () => {
    const outputs: string[] = []
    const { model, thread, post } = await setup(async (turn) => {
      if (turn.outputs.length === 1) outputs.push(turn.outputs[0]!)
      return answering('on it')(turn)
    })
    const root = await post({ channel: 'dev', text: '@helper what does wait do?' })

    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(1))
    expect(model.wakes).toEqual(['You have 1 new notification in #dev. Read it with `vb notifications`.'])
    expect(lines(outputs[0]!)).toMatchObject([{ reason: 'mention', type: 'message.posted', thread: root.id, by: { handle: 'julian' }, text: '@helper what does wait do?' }])
    const [reply] = (await thread(root.id)).replies
    expect(reply).toMatchObject({ text: 'on it', by: { actor: 'vboard:agent:helper', profile: 'helper', session: `thread-${root.id}` } })
  })

  it('post nothing for them: what they write as text stays theirs', async () => {
    const { model, thread, post } = await setup(() => [])
    const root = await post({ channel: 'dev', text: '@helper hello?' })

    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))
    await settle()
    expect((await thread(root.id)).replies).toEqual([])
  })

  it('wake the same session for what’s new in a thread it follows, and read each notification once', async () => {
    const reads: NotificationView[][] = []
    const { model, thread, post } = await setup(async (turn) => {
      if (turn.outputs.length === 1) reads.push(lines(turn.outputs[0]!))
      return answering('ack')(turn)
    })
    const root = await post({ channel: 'dev', text: '@helper look at this' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(1))

    const follow = await post({ re: root.id, text: 'and this' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(3))
    await settle()
    expect(model.wakes).toHaveLength(2)
    expect(reads.map((read) => read.map((n) => [n.reason, n.message]))).toEqual([[['mention', root.id]], [['subscribed', follow.id]]])
    expect((await thread(root.id)).replies.map((m) => m.by.session)).toEqual([`thread-${root.id}`, null, `thread-${root.id}`])
  })

  it('take a thread a session writes in with that session', async () => {
    const { thread, post } = await setup(({ outputs }) => {
      if (outputs.length === 0) return [{ command: 'notifications --json' }]
      if (outputs.length > 1) return []
      const [n] = lines(outputs[0]!)
      // On the first notification, it also asks in the other thread; later, it answers where it's told.
      return n!.reason === 'mention' ? [{ command: `reply ${n!.thread} "on it"` }, { command: `reply ${other.id} "is this related?"` }] : [{ command: `reply ${n!.thread} "thanks"` }]
    })
    const other = await post({ channel: 'ops', text: 'deploys are slow' })
    const root = await post({ channel: 'dev', text: '@helper why is wait slow?' })
    await vi.waitFor(async () => expect((await thread(other.id)).replies).toHaveLength(1))

    await post({ re: other.id, text: 'yes, same cause' })
    await vi.waitFor(async () => expect((await thread(other.id)).replies).toHaveLength(3))
    expect((await thread(other.id)).replies.map((m) => [m.text, m.by.session])).toEqual([
      ['is this related?', `thread-${root.id}`],
      ['yes, same cause', null],
      ['thanks', `thread-${root.id}`],
    ])
  })

  it('stop waking for a thread they unsubscribed from', async () => {
    const { model, thread, post } = await setup(({ outputs }) => {
      if (outputs.length === 0) return [{ command: 'notifications --json' }]
      return outputs.length === 1 ? [{ command: `unsubscribe ${lines(outputs[0]!)[0]!.thread}` }] : []
    })
    const root = await post({ channel: 'dev', text: '@helper not for you, sorry' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))
    await settle()

    await post({ re: root.id, text: 'carry on' })
    await settle()
    expect(model.wakes).toHaveLength(1)
    expect((await thread(root.id)).replies.map((m) => m.text)).toEqual(['carry on'])
  })

  it('let notify decide who reaches them', async () => {
    const { model, board, post } = await setup(() => [], { notify: ({ author }) => author.handle === 'julian' })
    const ines = caller(board.fetch, await personToken('u_ines'), { 'x-board-handle': 'ines' })
    await ines('POST', '/messages', { channel: 'dev', text: '@helper run the migration' })
    await settle()
    expect(model.wakes).toEqual([])

    await post({ channel: 'dev', text: '@helper run the migration' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))
  })

  it('cover a burst with the wakeup already waiting: one more turn reads it all', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const hold = tool({ inputSchema: z.object({}), execute: async () => (await gate, 'released') })
    const reads: NotificationView[][] = []
    const { model, post } = await setup(({ outputs }) => {
      if (model.wakes.length === 1) return outputs.length === 0 ? [{ tool: 'hold', input: {} }] : []
      if (outputs.length === 0) return [{ command: 'notifications --json' }]
      if (outputs.length === 1) reads.push(lines(outputs[0]!))
      return []
    }, {}, { hold })
    const root = await post({ channel: 'dev', text: '@helper watch this thread' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))

    const burst = [await post({ re: root.id, text: 'one' }), await post({ re: root.id, text: 'two' }), await post({ re: root.id, text: 'three' })]
    await settle()
    release()

    await vi.waitFor(() => expect(reads).toHaveLength(1))
    await settle()
    expect(model.wakes).toHaveLength(2)
    // The first turn never read its mention, so the next one reads it with the burst.
    expect(reads[0]!.map((n) => n.message)).toEqual([root.id, ...burst.map((m) => m.id)])
  })

  it('put every thread in one session, one inbox, when told to', async () => {
    const { thread, post } = await setup(answering('seen'), { session: 'main' })
    const one = await post({ channel: 'dev', text: '@helper first' })
    const two = await post({ channel: 'ops', text: '@helper second' })

    await vi.waitFor(async () => {
      expect((await thread(one.id)).replies).toHaveLength(1)
      expect((await thread(two.id)).replies).toHaveLength(1)
    })
    expect((await thread(one.id)).replies[0]!.by.session).toBe('main')
    expect((await thread(two.id)).replies[0]!.by.session).toBe('main')
  })

  it('stop a failed turn when the next notification comes, so it runs', async () => {
    let failing = true
    const { thread, post } = await setup((turn) => {
      if (failing) throw new Error('model overloaded')
      return answering('back')(turn)
    })
    const root = await post({ channel: 'dev', text: '@helper are you there?' })
    await settle()
    expect((await thread(root.id)).replies).toEqual([])

    failing = false
    await post({ re: root.id, text: 'try again' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies.map((m) => m.text)).toContain('back'))
  })

  it('stop a failed turn with a wakeup already queued behind it, so the session answers again', async () => {
    let failing = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { thread, post } = await setup(async (turn) => {
      if (failing) {
        await gate
        throw new Error('model overloaded')
      }
      return answering('back')(turn)
    })
    const root = await post({ channel: 'dev', text: '@helper are you there?' })
    await settle()
    // Arrives while the first turn runs: its wakeup waits behind the turn that's about to fail.
    await post({ re: root.id, text: 'hello?' })
    await settle()
    failing = false
    release()
    await settle()
    await post({ re: root.id, text: 'try again' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies.map((m) => m.text)).toContain('back'))
  })

  it('wake on what their watch matches, as a watcher would', async () => {
    const outputs: string[] = []
    const { model, post } = await setup(
      async (turn) => {
        if (turn.outputs.length === 1) outputs.push(turn.outputs[0]!)
        return turn.outputs.length === 0 ? [{ command: 'notifications' }] : []
      },
      { watch: 'prs --label pr' },
    )
    await post({ channel: 'prs', text: 'unrelated chatter' })
    const pr = await post({ channel: 'prs', text: 'PR #12: faster wait', labels: { pr: 'acme/www#12' } })

    await vi.waitFor(() => expect(outputs).toHaveLength(1))
    expect(model.wakes).toHaveLength(1)
    expect(outputs[0]).toMatch(new RegExp(`@julian started thread #${pr.id} in prs, which your watch matches\\n  PR #12: faster wait$`))
  })

  it('reach other agents like anyone, unless notify says otherwise', async () => {
    const run = async (reviewerNotify?: AgentConfig['notify']) => {
      const store = memory()
      const helperModel = scripted(answering('on it'))
      const reviewerModel = scripted(() => [])
      const helper = agent({ name: 'helper', store, model: 'test/model', maxSteps: 8, tools: { vb }, harness: helperModel.harness })
      const reviewer = agent({ name: 'reviewer', store, model: 'test/model', maxSteps: 8, tools: { vb }, harness: reviewerModel.harness })
      const { fetch } = testBoard({ store, agents: { helper, reviewer: { run: reviewer, ...(reviewerNotify ? { notify: reviewerNotify } : {}) } } })
      const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
      const root = (await julian('POST', '/messages', { channel: 'dev', text: '@helper @reviewer look' })).body.message as MessageView
      await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies).toHaveLength(1))
      await settle()
      return reviewerModel.wakes
    }
    // Helper's reply reaches Reviewer, which follows the thread: its notifications cover both.
    expect(await run()).toHaveLength(2)
    expect(await run(({ author, isMentioned }) => isMentioned || author.kind !== 'agent')).toHaveLength(1)
  })

  it('post every reply even when the model reuses tool call IDs across sessions', async () => {
    const model = scripted(answering('seen'), { callIds: () => 'call_0' })
    const store = memory()
    const helper = agent({ name: 'helper', store, model: 'test/model', maxSteps: 8, tools: { vb }, harness: model.harness })
    const { fetch } = testBoard({ store, agents: { helper } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
    const one = (await julian('POST', '/messages', { channel: 'dev', text: '@helper first' })).body.message as MessageView
    const two = (await julian('POST', '/messages', { channel: 'dev', text: '@helper second' })).body.message as MessageView

    for (const root of [one, two])
      await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies.map((m: MessageView) => m.text)).toEqual(['seen']))
  })

  it('post each turn’s reply when the model reuses tool call IDs in one session', async () => {
    let n = 0
    let root = 0
    const model = scripted((turn) => (turn.outputs.length === 0 ? [{ command: `reply ${root} "seen ${++n}"` }] : []), { callIds: () => 'call_0' })
    const store = memory()
    const helper = agent({ name: 'helper', store, model: 'test/model', maxSteps: 8, tools: { vb }, harness: model.harness })
    const { fetch } = testBoard({ store, agents: { helper } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
    root = ((await julian('POST', '/messages', { channel: 'dev', text: '@helper first' })).body.message as MessageView).id
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root}`)).body.replies).toHaveLength(1))
    await julian('POST', '/messages', { re: root, text: 'again' })
    await vi.waitFor(async () =>
      expect((await julian('GET', `/messages/${root}`)).body.replies.map((m: MessageView) => m.text)).toEqual(['seen 1', 'again', 'seen 2']),
    )
  })
})

describe('agents with a harness of their own', () => {
  it('get each notification with the session and a board that acts as them there', async () => {
    const seen: { session: string; notification: NotificationView; unread: number }[] = []
    const board = testBoard({
      agents: {
        own: {
          run: async ({ session, board, notification }: AgentRunContext) => {
            seen.push({ session, notification, unread: (await board.notifications()).length })
            if (notification.reason === 'mention') await board.reply(notification.thread, { text: 'on it' })
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'dev', text: '@own hello?' })).body.message as MessageView
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ session: `thread-${root.id}`, notification: { reason: 'mention', thread: root.id }, unread: 1 })
    const [reply] = (await julian('GET', `/messages/${root.id}`)).body.replies as MessageView[]
    expect(reply).toMatchObject({ text: 'on it', by: { actor: 'vboard:agent:own', session: `thread-${root.id}` } })
  })

  it('hear everything that happens in a thread they follow: edits, reactions, labels, and deletes', async () => {
    const seen: NotificationView[] = []
    const board = testBoard({ agents: { own: { run: ({ notification }: AgentRunContext) => void seen.push(notification) } } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'dev', text: '@own ship it?' })).body.message as MessageView
    const reply = (await julian('POST', '/messages', { re: root.id, text: 'ready' })).body.message as MessageView
    await julian('POST', `/messages/${reply.id}/reactions`, { emoji: 'shipit' })
    await julian('POST', `/messages/${root.id}/labels`, { set: { state: 'merged' }, unset: ['kind'] })
    await julian('POST', `/messages/${root.id}/edit`, { text: '@own ship it? (done)' })
    await julian('POST', `/messages/${reply.id}/delete`, {})

    await vi.waitFor(() => expect(seen).toHaveLength(6))
    expect(seen.map((n) => [n.reason, n.type])).toEqual([
      ['mention', 'message.posted'],
      ['subscribed', 'message.posted'],
      ['subscribed', 'reaction.added'],
      ['subscribed', 'labels.changed'],
      ['subscribed', 'message.edited'],
      ['subscribed', 'message.deleted'],
    ])
    expect(seen[2]).toMatchObject({ emoji: 'shipit', message: reply.id })
    expect(seen[3]).toMatchObject({ labels: { set: { state: 'merged' }, unset: ['kind'] } })
  })

  it('say so as the board when they can’t be woken, and try again on the next message', async () => {
    let down = true
    const woken: NotificationView[] = []
    const board = testBoard({
      agents: {
        own: {
          name: 'Own',
          run: async ({ notification }: AgentRunContext) => {
            if (down) throw new Error('sandbox down\nat start()')
            woken.push(notification)
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const agents = board.servers.find((server) => server.contract.name === 'vboard-agents')!
    const root = (await julian('POST', '/messages', { channel: 'dev', text: '@own hello?' })).body.message as MessageView

    // Each drain is the queue's next try.
    await vi.waitFor(async () => {
      await agents.drain('agent:own')
      expect((await julian('GET', `/messages/${root.id}`)).body.replies).toHaveLength(1)
    }, { timeout: 10_000, interval: 5 })
    expect((await julian('GET', `/messages/${root.id}`)).body.replies[0]).toMatchObject({
      text: "Own couldn't start: sandbox down. Reply to try again.",
      by: { actor: 'vboard:agents' },
    })
    down = false
    await julian('POST', '/messages', { re: root.id, text: 'try again' })
    await vi.waitFor(() => expect(woken).toHaveLength(1))
    expect(woken[0]).toMatchObject({ reason: 'subscribed', type: 'message.posted', thread: root.id, by: { handle: 'julian' } })
  })
})

describe('agents that run elsewhere', () => {
  it('read their notifications themselves, per session, from the board’s own deployment', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const board = testBoard({ agents: { reviewer: { name: 'Reviewer' } } })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const reviewer = caller(board.fetch, await deploymentToken('board', PROJECT_ID), { 'x-board-profile': 'reviewer', 'x-board-session': 'thread-1' })
    const root = (await julian('POST', '/messages', { channel: 'dev', text: '@reviewer please look' })).body.message as MessageView
    const session = caller(board.fetch, await deploymentToken('board', PROJECT_ID), { 'x-board-profile': 'reviewer', 'x-board-session': `thread-${root.id}` })

    await vi.waitFor(async () => expect((await session('GET', '/notifications')).body.notifications).toHaveLength(1))
    const [n] = (await session('GET', '/notifications')).body.notifications as NotificationView[]
    expect(n).toMatchObject({ reason: 'mention', thread: root.id, text: '@reviewer please look' })
    expect((await reviewer('GET', '/notifications')).body.notifications).toEqual([])

    expect((await session('POST', '/notifications/read', { through: n!.id })).status).toBe(200)
    expect((await session('GET', '/notifications')).body.notifications).toEqual([])
    expect((await julian('GET', '/notifications')).status).toBe(403)
    const sessionless = caller(board.fetch, await deploymentToken('board', PROJECT_ID), { 'x-board-profile': 'reviewer' })
    expect((await sessionless('GET', '/notifications')).body.error).toMatchObject({ code: 'no_session' })
    vi.unstubAllEnvs()
  })
})
