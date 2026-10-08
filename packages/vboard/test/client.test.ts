import { describe, expect, it } from 'vitest'
import { createClient } from '../src/client/index.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'
import { detectAgent } from '../src/client/node.ts'

async function setup(userId = 'u_julian', handle = 'julian', profile: string | null = null) {
  const board = testBoard()
  const token = await personToken(userId)
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    board.fetch(new Request(input, init))) as typeof globalThis.fetch
  const client = createClient({ url: BOARD_URL, token, handle, profile, fetch })
  return { board, client, fetch }
}

describe('client', () => {
  it('posts, replies, and reads threads', async () => {
    const { client } = await setup()
    const root = await client.post('errors-www', { text: 'deploy failed', labels: { status: 'open' } })
    await client.reply(root.id, 'rolled back')
    const thread = await client.thread(root.id)
    expect(thread.message.labels).toEqual({ status: 'open' })
    expect(thread.replies.map((m) => m.text)).toEqual(['rolled back'])
    expect(thread.message.author).toMatchObject({ handle: 'julian' })
  })

  it('throws BoardError with the server code', async () => {
    const { client } = await setup()
    await expect(client.thread(999)).rejects.toMatchObject({
      name: 'BoardError',
      code: 'message_not_found',
      status: 404,
    })
    await expect(client.post('Bad Channel', 'x')).rejects.toMatchObject({ name: 'BoardError', code: 'invalid_request', status: 400 })
  })

  it('waits for the next matching event, or times out with null', async () => {
    const { client } = await setup()
    const root = await client.post('x', 'question')
    const waiting = client.wait({ re: root.id }, { timeout: '5s' })
    setTimeout(() => void client.reply(root.id, 'answer'), 50)
    const event = await waiting
    expect(event?.message?.text).toBe('answer')
    expect(await client.wait({ re: root.id }, { timeout: 200 })).toBeNull()
  })

  it('streams live events and resumes after the server closes the stream', async () => {
    const board = testBoard({ streamMaxMs: 150 })
    const token = await personToken()
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      board.fetch(new Request(input, init))) as typeof globalThis.fetch
    const client = createClient({ url: BOARD_URL, token, fetch })
    const controller = new AbortController()
    const seen: string[] = []
    const reading = (async () => {
      for await (const event of client.events({ channel: 'x' }, { signal: controller.signal })) {
        seen.push(event.message!.text)
        if (seen.length === 3) controller.abort()
      }
    })()
    await new Promise((r) => setTimeout(r, 50))
    await client.post('x', 'one')
    await new Promise((r) => setTimeout(r, 300)) // the server closes and the client reconnects
    await client.post('y', 'elsewhere')
    await client.post('x', 'two')
    await new Promise((r) => setTimeout(r, 300))
    await client.post('x', 'three')
    await reading
    expect(seen).toEqual(['one', 'two', 'three'])
  })
})

describe('agent detection', () => {
  it('knows Claude Code, Codex, Grok, and pi, and any agent that sets AI_AGENT', () => {
    expect(detectAgent({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' })).toEqual({ profile: 'claude', session: 's1' })
    expect(detectAgent({ CODEX_THREAD_ID: 't1' })).toEqual({ profile: 'codex', session: 't1' })
    expect(detectAgent({ PI_CODING_AGENT: 'true', AI_AGENT: 'pi', PI_SESSION_ID: 'p1' })).toEqual({ profile: 'pi', session: 'p1' })
    expect(detectAgent({ AI_AGENT: 'OpenCode' })).toEqual({ profile: 'opencode', session: null })
    expect(detectAgent({ AI_AGENT: 'not a name!' })).toBeNull()
    expect(detectAgent({})).toBeNull()
  })
})
