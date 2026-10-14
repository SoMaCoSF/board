import type { UIMessage, UIMessageChunk } from 'ai'
import type { AISDKHarness } from 'experimental-a2/ai/server'
import { tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { MessageView } from '../src/api/routes.ts'
import { agent } from '../src/agents/index.ts'
import { caller, personToken, testBoard } from './harness.ts'

type Call = { tool?: string; command?: string; input?: unknown }

/** A model that makes the tool calls `script` returns for each wakeup, then stops. */
function scripted(script: (wake: string) => Call[] | Promise<Call[]>, options: { callIds?: (n: number) => string } = {}) {
  const wakes: string[] = []
  const harness: AISDKHarness = {
    type: 'ai-sdk',
    compaction: false,
    generate: async ({ event, messages }) => {
      const id = (event.payload as { responseMessageId: string }).responseMessageId
      const user = messages.findLastIndex((m: UIMessage) => m.role === 'user')
      const called = messages.slice(user + 1).some((m: UIMessage) => m.parts.some((p) => p.type.startsWith('tool-')))
      const text = messages[user]!.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      let chunks: UIMessageChunk[]
      if (called) chunks = [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }]
      else {
        wakes.push(text)
        chunks = (await script(text)).map((call, n) => ({
          type: 'tool-input-available',
          toolCallId: options.callIds?.(n) ?? `${id}-${n}`,
          toolName: call.tool ?? 'vb',
          input: call.input ?? { command: call.command },
        }))
      }
      return new ReadableStream({
        start(controller) {
          for (const chunk of [{ type: 'start', messageId: id }, { type: 'start-step' }, ...chunks, { type: 'finish-step' }, { type: 'finish' }] as UIMessageChunk[])
            controller.enqueue(chunk)
          controller.close()
        },
      })
    },
  }
  return { harness, wakes }
}

const threadOf = (wake: string) => Number(/vb read (\d+)/.exec(wake)![1])
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

async function setup(config: Parameters<typeof agent>[0] extends infer O ? Partial<O> : never, script: Parameters<typeof scripted>[0]) {
  const model = scripted(script)
  const helper = agent({ name: 'Helper', model: 'test/model', maxSteps: 4, ...config, harness: model.harness })
  const { fetch } = testBoard({ agents: { helper } })
  const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
  const ines = caller(fetch, await personToken('u_ines'), { 'x-board-handle': 'ines' })
  const thread = async (id: number) => (await julian('GET', `/messages/${id}`)).body as { message: MessageView; replies: MessageView[] }
  const post = async (as: typeof julian, body: Record<string, unknown>) => (await as('POST', '/messages', body)).body.message as MessageView
  return { model, julian, ines, thread, post }
}

describe('agents the board runs', () => {
  it('wake on a mention with a notification, never its text, and reply through vb as themselves', async () => {
    const { model, julian, thread, post } = await setup({}, (wake) => [{ command: `reply ${threadOf(wake)} "on it"` }])
    const root = await post(julian, { channel: 'dev', text: '@helper what does wait do?' })

    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(1))
    expect(model.wakes).toEqual([`New notification: @julian mentioned you in a new thread, #${root.id} in dev. Read it with \`vb read ${root.id}\`.`])
    const [reply] = (await thread(root.id)).replies
    expect(reply).toMatchObject({ text: 'on it', by: { actor: 'vboard:agent:helper', profile: 'helper', session: `thread-${root.id}` } })
    expect(reply!.author).toMatchObject({ kind: 'agent', handle: 'helper', name: 'Helper' })
  })

  it('post nothing for them: what they write as text stays theirs', async () => {
    const { model, julian, thread, post } = await setup({}, () => [])
    const root = await post(julian, { channel: 'dev', text: '@helper hello?' })

    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))
    await settle()
    expect((await thread(root.id)).replies).toEqual([])
  })

  it('wake on new replies in threads they follow, but not on their own', async () => {
    const { model, julian, thread, post } = await setup({}, (wake) => [{ command: `reply ${threadOf(wake)} "ack"` }])
    const root = await post(julian, { channel: 'dev', text: '@helper look at this' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(1))

    const follow = await post(julian, { re: root.id, text: 'and this' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(3))
    await settle()
    expect(model.wakes).toHaveLength(2)
    expect(model.wakes[1]).toBe(`New notification: @julian replied in thread #${root.id} in dev, which you follow: #${follow.id}. Read it with \`vb read ${root.id}\`.`)
  })

  it('stop waking for a thread they unsubscribed from', async () => {
    const { model, julian, thread, post } = await setup({}, (wake) =>
      model.wakes.length === 1 ? [{ command: `unsubscribe ${threadOf(wake)}` }] : [{ command: `reply ${threadOf(wake)} "still here"` }],
    )
    const root = await post(julian, { channel: 'dev', text: '@helper not for you, sorry' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))
    await settle()

    await post(julian, { re: root.id, text: 'carry on' })
    await settle()
    expect(model.wakes).toHaveLength(1)
    expect((await thread(root.id)).replies.map((m) => m.text)).toEqual(['carry on'])
  })

  it('let notify decide who wakes them', async () => {
    const { model, julian, ines, post } = await setup({ notify: ({ author }) => author.handle === 'julian' }, () => [])
    await post(ines, { channel: 'dev', text: '@helper run the migration' })
    await settle()
    expect(model.wakes).toEqual([])

    await post(julian, { channel: 'dev', text: '@helper run the migration' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))
  })

  it('fold a burst that arrives behind a running turn into one wakeup', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const hold = tool({ inputSchema: z.object({}), execute: async () => (await gate, 'released') })
    const { model, julian, thread, post } = await setup({ tools: { hold } }, (wake) =>
      model.wakes.length === 1 ? [{ tool: 'hold', input: {} }] : [{ command: `reply ${threadOf(wake)} "caught up"` }],
    )
    const root = await post(julian, { channel: 'dev', text: '@helper watch this thread' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))

    const replies = [await post(julian, { re: root.id, text: 'one' }), await post(julian, { re: root.id, text: 'two' }), await post(julian, { re: root.id, text: 'three' })]
    await settle()
    release()

    await vi.waitFor(async () => expect((await thread(root.id)).replies.map((m) => m.text)).toContain('caught up'))
    await settle()
    expect(model.wakes).toHaveLength(2)
    expect(model.wakes[1]).toBe(
      ['New notifications:', ...replies.map((m) => `- @julian replied in thread #${root.id} in dev, which you follow: #${m.id}. Read it with \`vb read ${root.id}\`.`)].join('\n'),
    )
  })

  it('share one session across threads when told to', async () => {
    const { julian, thread, post } = await setup({ session: 'shared' }, (wake) => [{ command: `reply ${threadOf(wake)} "seen"` }])
    const one = await post(julian, { channel: 'dev', text: '@helper first' })
    const two = await post(julian, { channel: 'ops', text: '@helper second' })

    await vi.waitFor(async () => {
      expect((await thread(one.id)).replies).toHaveLength(1)
      expect((await thread(two.id)).replies).toHaveLength(1)
    })
    expect((await thread(one.id)).replies[0]!.by.session).toBe('shared')
    expect((await thread(two.id)).replies[0]!.by.session).toBe('shared')
  })

  it('fold notifications from several threads into a shared session’s waiting wakeup, losing none', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const hold = tool({ inputSchema: z.object({}), execute: async () => (await gate, 'released') })
    const { model, julian, post } = await setup({ session: 'shared', tools: { hold } }, () =>
      model.wakes.length === 1 ? [{ tool: 'hold', input: {} }] : [],
    )
    await post(julian, { channel: 'dev', text: '@helper first' })
    await vi.waitFor(() => expect(model.wakes).toHaveLength(1))

    const [two, three, four] = await Promise.all([
      post(julian, { channel: 'dev', text: '@helper second' }),
      post(julian, { channel: 'ops', text: '@helper third' }),
      post(julian, { channel: 'ops', text: '@helper fourth' }),
    ])
    await settle()
    release()

    await vi.waitFor(() => expect(model.wakes).toHaveLength(2))
    await settle()
    expect(model.wakes).toHaveLength(2)
    for (const root of [two!, three!, four!]) expect(model.wakes[1]).toContain(`\`vb read ${root.id}\``)
  })

  it('wake for another agent’s reply only when it mentions them, so two agents can’t answer each other forever', async () => {
    const helper = scripted((wake) => [{ command: `reply ${threadOf(wake)} "on it"` }])
    const reviewer = scripted(() => [])
    const { fetch } = testBoard({
      agents: {
        helper: agent({ name: 'Helper', model: 'test/model', maxSteps: 4, harness: helper.harness }),
        reviewer: agent({ name: 'Reviewer', model: 'test/model', maxSteps: 4, harness: reviewer.harness }),
      },
    })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'dev', text: '@helper @reviewer look' })).body.message as MessageView
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies).toHaveLength(1))

    await julian('POST', '/messages', { re: root.id, text: 'thanks' })
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies).toHaveLength(3))
    await settle()
    expect(helper.wakes).toHaveLength(2)
    expect(reviewer.wakes).toHaveLength(2)
    expect(reviewer.wakes.every((wake) => wake.includes('@julian'))).toBe(true)
  })

  it('post every reply even when the model reuses tool call IDs across sessions', async () => {
    const model = scripted((wake) => [{ command: `reply ${threadOf(wake)} "seen"` }], { callIds: () => 'call_0' })
    const { fetch } = testBoard({ agents: { helper: agent({ name: 'Helper', model: 'test/model', maxSteps: 4, harness: model.harness }) } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })
    const one = (await julian('POST', '/messages', { channel: 'dev', text: '@helper first' })).body.message as MessageView
    const two = (await julian('POST', '/messages', { channel: 'dev', text: '@helper second' })).body.message as MessageView

    for (const root of [one, two])
      await vi.waitFor(async () => expect((await julian('GET', `/messages/${root.id}`)).body.replies.map((m: MessageView) => m.text)).toEqual(['seen']))
  })

  it('say so as the board when a turn fails, and run again on the next reply', async () => {
    let failing = true
    const { model, julian, thread, post } = await setup({}, (wake) => {
      if (failing) throw new Error('model overloaded')
      return [{ command: `reply ${threadOf(wake)} "back"` }]
    })
    const root = await post(julian, { channel: 'dev', text: '@helper are you there?' })

    await vi.waitFor(async () => expect((await thread(root.id)).replies).toHaveLength(1), { timeout: 10_000 })
    const [notice] = (await thread(root.id)).replies
    expect(notice).toMatchObject({ text: "Helper couldn't finish: model overloaded. Reply to try again.", by: { actor: 'vboard:agents' } })

    failing = false
    await post(julian, { re: root.id, text: 'try again' })
    await vi.waitFor(async () => expect((await thread(root.id)).replies.map((m) => m.text)).toContain('back'))
    expect(model.wakes.at(-1)).toContain('replied in thread')
  }, 15_000)
})
