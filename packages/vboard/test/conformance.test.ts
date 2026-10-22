import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

type Fetch = (request: Request) => Promise<Response>

/** A handle on the board behind `fetch`, as `vb conformance` checks it. */
const clientOf = async (fetch: Fetch) => clientAs(fetch, () => personToken())

/** A handle on the board behind `fetch`, with the token `token` gives. */
const clientAs = async (fetch: Fetch, token: () => Promise<string>) =>
  board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

/** A board in front of `fetch` that rewrites what it answers, or what it's asked. */
function broken(fetch: Fetch, change: { request?: (url: URL) => void; body?: (text: string) => string }): Fetch {
  return async (request) => {
    const url = new URL(request.url)
    change.request?.(url)
    const response = await fetch(new Request(url, request))
    if (!change.body || !response.headers.get('content-type')?.includes('application/json')) return response
    return new Response(change.body(await response.text()), { status: response.status, headers: response.headers })
  }
}

describe('the conformance kit', () => {
  it('passes a board on a2(), checking the whole protocol, and deletes what it posted', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const client = await clientOf(board.fetch)
    const report = await conformance(client)
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
    expect(report).toMatchObject({ ok: true, url: BOARD_URL })
    expect([...new Set(report.checks.map((check) => check.group))]).toEqual(['core', 'schedules', 'attachments', 'watchers', 'sync'])
    const { messages } = await client.messages({ channel: 'conformance', limit: 500 })
    expect(messages.filter((message) => !message.deleted)).toEqual([])
  })

  it("passes through a board's own handle, in-process", async () => {
    const team = testBoard({ scheduler: fakeQueue().scheduler })
    const report = await conformance(team)
    expect(report.checks.filter((check) => check.status !== 'passed')).toEqual([])
    expect((await team.me()).actor).toBe('vboard:client')
  })

  it("leaves a token's registration as it was: one with watchers or a sync is skipped, and an empty one keeps its URL", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler, access: [vercelProject({ project: 'prj_v0', can: 'all' })] })
    const v0 = caller(board.fetch, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production'))
    const registered = async () => (await v0('GET', '/watchers')).body.watchers.map(({ hash: _hash, ...rest }: { hash: string }) => rest)
    const skipped = (report: Awaited<ReturnType<typeof conformance>>) =>
      report.checks.filter((check) => check.group === 'watchers' || check.group === 'sync').map((check) => check.status)
    for (const registration of [
      // A project's board on http() that syncs Slack and has no watchers of its own.
      { url: 'https://v0.test/api/board', watch: {}, sync: [{ key: 'slack', platform: 'slack', signIn: false }] },
      { url: 'https://v0.test/api/board', watch: { fix: { tail: 'feedback', when: 'matches' } }, sync: [] },
    ]) {
      expect((await v0('POST', '/watchers', registration)).status).toBe(200)
      const before = await registered()
      const report = await conformance(asV0)
      expect(skipped(report)).toEqual(['skipped', 'skipped'])
      expect(await registered()).toEqual(before)
    }
    // One with nothing in it is checked, and keeps where it's woken.
    const empty = { owner: 'vercel:project:prj_v0:production', url: 'https://v0.test/api/board', watch: {}, sync: [] }
    expect((await v0('POST', '/watchers', { url: empty.url, watch: {} })).status).toBe(200)
    const report = await conformance(asV0)
    expect(skipped(report)).toEqual(['passed', 'passed'])
    expect(await registered()).toEqual([empty])
  })

  it('fails a board that answers only part of the protocol', async () => {
    // Without a scheduler, a board on a2() can't schedule.
    const report = await conformance(await clientOf(testBoard().fetch))
    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.name, check.detail])).toEqual([
      ['schedules a reply, lists it, and cancels it', "this board has no scheduler, so it can't schedule messages"],
    ])
  })

  it('fails a board that shows its IDs as numbers', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const numeric = broken(board.fetch, { body: (text) => text.replace(/"(id|re)":"(\d+)"/g, '"$1":$2') })
    const report = await conformance(await clientOf(numeric))
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'posts a message, and reads it back by its ID')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining("a message's id should be a string of 1 to 128 characters, got 2"),
    })
  })

  it("fails a board whose reads ignore where they're asked to start", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const ignoring = broken(board.fetch, { request: (url) => url.pathname.endsWith('/messages') && url.searchParams.delete('after') })
    const report = await conformance(await clientOf(ignoring))
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.name, check.detail])).toEqual([
      ['reads a channel after a cursor or a message ID, oldest first', 'reading after a message should leave it out'],
    ])
  })

  it("reports a board whose discovery doesn't say where it is", async () => {
    const board = testBoard()
    const nameless = broken(board.fetch, { body: (text) => (text.includes('"audience"') ? text.replace(/"audience":"[^"]*",?/, '') : text) })
    const report = await conformance(await clientOf(nameless))
    expect(report).toMatchObject({
      ok: false,
      checks: [{ name: 'says in its discovery where it is', status: 'failed', detail: expect.stringContaining('discovery should have url, audience, and sync') }],
    })
  })
})
