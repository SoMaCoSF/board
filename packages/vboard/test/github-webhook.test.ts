import { createHmac } from 'node:crypto'
import { createGitHubAdapter } from '@chat-adapter/github'
import { expect, it, vi } from 'vitest'
import { github } from '../src/sync/github.ts'
import type { ReceivedEvent } from '../src/sync/provider.ts'

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
  expect(created?.event).toMatchObject({
    kind: 'message', thread: 'github:basehub-ai/vboard:100', message: '77', text: 'Building',
    url: 'https://github.com/basehub-ai/vboard/pull/100#issuecomment-77',
  })

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

it("links a comment the board posts to its html_url, from GitHub's answer to creating it", async () => {
  const created: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    created.push(`${init?.method ?? 'GET'} ${url}`)
    const reply = url.includes('/replies')
    const id = reply ? 91 : 90
    const html_url = `https://github.com/basehub-ai/vboard/pull/100#${reply ? `discussion_r${id}` : `issuecomment-${id}`}`
    return Response.json({ id, body: 'on it', user: { id: 1, login: 'vboard-factory[bot]', type: 'Bot' }, html_url }, { status: 201 })
  })
  try {
    const adapter = createGitHubAdapter({ token: 'ghp_test', webhookSecret: secret, userName: 'vboard-factory[bot]', botUserId: 1 })
    const provider = github({ adapter, repos: { 'basehub-ai/vboard': 'dev' } })
    expect(await provider.post('basehub-ai/vboard:100', 'thread', { markdown: 'on it' })).toEqual({
      thread: 'basehub-ai/vboard:100', message: '90', url: 'https://github.com/basehub-ai/vboard/pull/100#issuecomment-90',
    })
    expect(await provider.post('basehub-ai/vboard:100:rc:88', 'thread', { markdown: 'on it' })).toMatchObject({
      message: '91', url: 'https://github.com/basehub-ai/vboard/pull/100#discussion_r91',
    })
    expect(await provider.postAs('ghu_ada', 'basehub-ai/vboard:100', 'thread', { markdown: 'on it' })).toEqual({
      thread: 'basehub-ai/vboard:100', message: '90', url: 'https://github.com/basehub-ai/vboard/pull/100#issuecomment-90',
    })
    expect(created).toEqual([
      'POST https://api.github.com/repos/basehub-ai/vboard/issues/100/comments',
      'POST https://api.github.com/repos/basehub-ai/vboard/pulls/100/comments/88/replies',
      'POST https://api.github.com/repos/basehub-ai/vboard/issues/100/comments',
    ])
  } finally {
    vi.unstubAllGlobals()
  }
})
