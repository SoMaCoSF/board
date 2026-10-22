import { createHmac } from 'node:crypto'
import { createGitHubAdapter } from '@chat-adapter/github'
import { expect, it } from 'vitest'
import { github } from '../src/sync/github.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'
import { BOARD_URL, testBoard } from './harness.ts'

const secret = 'test-secret'
const repository = { id: 1, name: 'vboard', full_name: 'basehub-ai/vboard', owner: { id: 2, login: 'basehub-ai' } }
const vercel = { id: 35613825, login: 'vercel[bot]', type: 'Bot' }

function setup() {
  const adapter = createGitHubAdapter({ token: 'ghp_test', webhookSecret: secret, userName: 'vboard-factory[bot]', botUserId: 1 })
  const provider = github({ adapter, repos: { 'basehub-ai/vboard': 'dev' } })
  return async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload)
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const request = new Request('https://board.test/webhooks/github', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': `${event}:${Math.random()}`, 'x-hub-signature-256': signature },
    })
    const received: ReceivedEvent[] = []
    const response = await provider.receive('github', request, async (e) => void received.push(e))
    expect(response.status).toBe(200)
    return received
  }
}

const comment = (body: string, updated = '2026-10-07T19:51:48Z') => ({
  id: 77, body, user: vercel, created_at: '2026-10-07T19:51:48Z', updated_at: updated,
  html_url: 'https://github.com/basehub-ai/vboard/pull/100#issuecomment-77',
})
const issue = { number: 100, title: 'slack: agents post under their own name', pull_request: { url: 'x' } }

it('syncs an edited PR comment, like the Vercel deployment comment moving from Building to Ready', async () => {
  const send = setup()
  const [created] = await send('issue_comment', { action: 'created', comment: comment('Building'), issue, repository, sender: vercel })
  expect(created?.event).toMatchObject({ kind: 'message', thread: 'github:basehub-ai/vboard:100', message: '77', text: 'Building' })

  const edited = await send('issue_comment', {
    action: 'edited', comment: comment('Ready', '2026-10-07T19:53:10Z'), changes: { body: { from: 'Building' } }, issue, repository, sender: vercel,
  })
  expect(edited).toHaveLength(1)
  expect(edited[0]!.event).toMatchObject({ kind: 'edited', thread: 'github:basehub-ai/vboard:100', message: '77', text: 'Ready' })
})

it('syncs a deleted PR comment', async () => {
  const send = setup()
  const deleted = await send('issue_comment', { action: 'deleted', comment: comment('Ready'), issue, repository, sender: vercel })
  expect(deleted).toHaveLength(1)
  expect(deleted[0]!.event).toMatchObject({ kind: 'deleted', thread: 'github:basehub-ai/vboard:100', message: '77' })
})

it('syncs an edited inline review comment into its review thread', async () => {
  const send = setup()
  const review = { ...comment('nit: rename', '2026-10-07T19:53:10Z'), id: 88, path: 'src/index.ts', line: 3, user: { id: 42, login: 'julianbenegas', type: 'User' } }
  const edited = await send('pull_request_review_comment', {
    action: 'edited', comment: review, pull_request: { number: 100 }, repository, sender: review.user,
  })
  expect(edited[0]?.event).toMatchObject({ kind: 'edited', thread: 'github:basehub-ai/vboard:100', subthread: 'github:basehub-ai/vboard:100:rc:88', message: '88', text: 'nit: rename' })
})

it("ignores edits to the board's own comments, which it already has", async () => {
  const send = setup()
  const own = { ...comment('from the board', '2026-10-07T19:53:10Z'), user: { id: 1, login: 'vboard-factory[bot]', type: 'Bot' } }
  expect(await send('issue_comment', { action: 'edited', comment: own, issue, repository, sender: own.user })).toEqual([])
  const theirs = { ...own, user: vercel }
  const [edited] = await send('issue_comment', { action: 'edited', comment: theirs, issue, repository, sender: vercel })
  expect(edited?.event).toMatchObject({ kind: 'edited', message: '77', text: 'from the board' })
})

it('stops reading an unsigned webhook body once it is past the limit, and still verifies a signed one', async () => {
  const adapter = createGitHubAdapter({ token: 'ghp_test', webhookSecret: secret, userName: 'vboard-factory[bot]', botUserId: 1 })
  const board = testBoard({ sync: { github: github({ adapter, repos: { 'basehub-ai/vboard': 'dev' } }) } })
  let sent = 0
  const flooding = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === 64 * 1024 * 1024) return controller.close()
      sent += 1024 * 1024
      controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20))
    },
  })
  const flood = await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
    method: 'POST', headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'flood' }, body: flooding, duplex: 'half',
  } as RequestInit))
  expect(sent).toBeLessThanOrEqual(6 * 1024 * 1024)
  expect(flood.status).toBe(413)

  const declared = await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
    method: 'POST', headers: { 'x-github-event': 'issue_comment', 'content-length': String(64 * 1024 * 1024) }, body: '{}',
  }))
  expect(declared.status).toBe(413)

  const body = JSON.stringify({ action: 'deleted', comment: comment('Ready'), issue, repository, sender: vercel })
  const signed = (signature: string) => board.fetch(new Request(`${BOARD_URL}/webhooks/github`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-github-delivery': 'signed', 'x-hub-signature-256': signature },
  }))
  expect((await signed('sha256=0')).status).toBe(401)
  expect((await signed(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)).status).toBe(200)
})
