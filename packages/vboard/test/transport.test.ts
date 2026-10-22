import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

/** The status the fake server answers a wake-up with, and its body. */
const answer = vi.hoisted(() => ({ status: 200, body: '' }))

// https to a public address can't run in a test: the request answers from `answer` instead.
vi.mock('node:https', () => ({
  request: (_url: URL, _options: unknown, onResponse: (response: EventEmitter & { statusCode: number }) => void) => {
    const sent = new EventEmitter() as EventEmitter & { end: (body: string) => void }
    sent.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: answer.status })
      onResponse(response)
      queueMicrotask(() => {
        if (answer.body) response.emit('data', Buffer.from(answer.body))
        response.emit('end')
      })
    }
    return sent
  },
}))

const { publicPost } = await import('../src/server/transport.ts')
const wake = () => publicPost('https://pong.test/api/board/wake', { headers: {}, body: '{}', signal: new AbortController().signal })

describe('waking a board', () => {
  it('reads an answer with no body, or any status a server sends, without throwing out of its listener', async () => {
    const uncaught: unknown[] = []
    const record = (error: unknown) => void uncaught.push(error)
    process.on('uncaughtException', record)
    try {
      for (const status of [204, 205, 304]) {
        answer.status = status
        expect((await wake()).status, String(status)).toBe(status)
      }
      // A status a Response can't have is a bad gateway.
      Object.assign(answer, { status: 999, body: 'nope' })
      expect((await wake()).status).toBe(502)
      Object.assign(answer, { status: 500, body: 'down' })
      const failed = await wake()
      expect([failed.status, await failed.text()]).toEqual([500, 'down'])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }
  })
})
