import { board, type Caller, type Method } from '@vercel/board'
import { expect, it } from 'vitest'
import { messageboard } from '../src/index.ts'

// Nothing listens on port 9: a call that reached the API would fail with 502, not 403.
const options = { url: 'http://127.0.0.1:9', token: 'unused', teamId: 'team_test', boardId: 'brd_test' }

const verified = {
  identity: { principal: { id: 'vercel:user:restricted' }, author: {}, actor: { id: 'vercel:user:restricted' } },
  origin: { via: null },
} as unknown as Caller

it('refuses every call from a caller board() verified, whose grants it would drop', async () => {
  const backend = messageboard(options)
  const methods = Object.keys(backend).filter((name) => !['routes', 'keeps', 'bind'].includes(name)) as Method[]
  expect(methods).toContain('post')
  for (const method of methods) {
    const call = backend[method] as (caller: Caller, input: unknown, signal: AbortSignal) => Promise<unknown>
    await expect(call(verified, {}, new AbortController().signal), method).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  }
})

it("serves this deployment's own code, as the token's holder", async () => {
  const backend = messageboard(options)
  const own: Caller = { self: null, origin: { via: { kind: 'client', name: null } } }
  await expect(backend.me(own, {}, new AbortController().signal)).rejects.toMatchObject({ status: 502, code: 'unreachable' })
})

it('refuses watchers and sync it would never run', () => {
  expect(() => board({ backend: messageboard(options), watch: { triage: { tail: 'general', run: async () => {} } } })).toThrow(/no watchers or sync/)
})
