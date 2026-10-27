import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance as check } from '../src/conformance/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

type Fetch = (request: Request) => Promise<Response>

/** A handle on the board behind `fetch`, as `vb conformance` checks it. */
const clientOf = async (fetch: Fetch) => clientAs(fetch, () => personToken())

/** How each handle's board is reached: where the delegate token the kit mints goes. */
const reach = new WeakMap<object, Fetch>()

/** A handle on the board behind `fetch`, with the token `token` gives. */
const clientAs = async (fetch: Fetch, token: () => Promise<string>) => {
  const handle = board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)
  reach.set(handle, fetch)
  return handle
}

/** The kit, on a handle, its delegate reaching the board as the handle does. */
const conformance = (handle: Parameters<typeof check>[0]) => {
  const fetch = reach.get(handle) ?? (handle as { fetch?: Fetch }).fetch
  return check(handle, fetch ? { fetch: (input, init) => fetch(new Request(input, init)) } : {})
}

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

/** A board in front of `fetch` from before `path`: a registration drops it, as its schema did. */
function withoutPath(fetch: Fetch): Fetch {
  return async (request) => {
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/watchers')) return fetch(request)
    const { path: _path, ...body } = await request.json()
    return fetch(new Request(request, { body: JSON.stringify(body) }))
  }
}

/**
 * A board in front of `fetch` that wakes by path, as the team board does: it refuses a path from a
 * person, and keeps one (and a preview's branch) as a URL on a host that never resolves, which it
 * shows as the path.
 */
function wakingByPath(fetch: Fetch): Fetch {
  const host = 'https://path.invalid'
  return async (request) => {
    const url = new URL(request.url)
    let forwarded = request
    if (request.method === 'POST' && url.pathname.endsWith('/watchers')) {
      const { path, branch, ...body } = await request.json()
      const claims = JSON.parse(Buffer.from(request.headers.get('authorization')!.split('.')[1]!, 'base64url').toString())
      if (path && claims.user_id) return Response.json({ error: { code: 'not_a_project', message: "a path is on the caller's own project" } }, { status: 403 })
      const at = `${host}${path}${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`
      forwarded = new Request(request, { body: JSON.stringify(path ? { ...body, url: at } : body) })
    }
    const response = await fetch(forwarded)
    if (!response.headers.get('content-type')?.includes('application/json')) return response
    let text = (await response.text()).replace(
      /"url":"https:\/\/path\.invalid([^"?]*)(?:\?branch=([^"]*))?"/g,
      (_, path: string, branch?: string) => `"url":null,"path":${JSON.stringify(path)}${branch ? `,"branch":${JSON.stringify(decodeURIComponent(branch))}` : ''}`,
    )
    if (request.method === 'GET' && url.pathname.replace(/\/$/, '') === new URL(BOARD_URL).pathname) text = text.replace(/^\{/, '{"wake_by_path":true,')
    return new Response(text, { status: response.status, headers: response.headers })
  }
}

/** The watcher and sync checks' statuses, in order. */
const watcherStatuses = (report: Awaited<ReturnType<typeof conformance>>) =>
  report.checks.filter((check) => check.group === 'watchers' || check.group === 'sync').map((check) => check.status)

describe('the conformance kit', () => {
  it('passes a board on a2(), checking the whole protocol, and deletes what it posted', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const client = await clientOf(board.fetch)
    const report = await conformance(client)
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
    expect(report).toMatchObject({ ok: true, url: BOARD_URL })
    expect([...new Set(report.checks.map((check) => check.group))]).toEqual(['core', 'schedules', 'attachments', 'watchers', 'sync', 'tokens'])
    const { messages } = await client.messages({ channel: 'conformance', limit: 500 })
    expect(messages.filter((message) => !message.deleted)).toEqual([])
  })

  it("passes through a board's own handle, in-process", async () => {
    const team = testBoard({ scheduler: fakeQueue().scheduler })
    const report = await conformance(team)
    expect(report.checks.filter((check) => check.status !== 'passed')).toEqual([])
    expect((await team.me()).actor).toBe('board:client')
  })

  it("leaves a token's registration as it was: one with watchers or a sync is skipped, and an empty one keeps its URL", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler, access: [vercelProject({ project: 'prj_v0', can: 'all' })] })
    const v0 = caller(board.fetch, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production'))
    const registered = async () => (await v0('GET', '/watchers')).body.watchers.map(({ hash: _hash, ...rest }: { hash: string }) => rest)
    for (const registration of [
      // A project's board on http() that syncs Slack and has no watchers of its own.
      { url: 'https://v0.test/api/board', watch: {}, sync: [{ key: 'slack', platform: 'slack', signIn: false }] },
      { url: 'https://v0.test/api/board', watch: { fix: { tail: 'feedback', when: 'matches' } }, sync: [] },
    ]) {
      expect((await v0('POST', '/watchers', registration)).status).toBe(200)
      const before = await registered()
      const report = await conformance(asV0)
      expect(watcherStatuses(report)).toEqual(['skipped', 'skipped', 'skipped'])
      expect(await registered()).toEqual(before)
    }
    // One with nothing in it is checked, and keeps where it's woken.
    const empty = { owner: 'vercel:project:prj_v0:production', url: 'https://v0.test/api/board', watch: {}, sync: [] }
    expect((await v0('POST', '/watchers', { url: empty.url, watch: {} })).status).toBe(200)
    const report = await conformance(asV0)
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed'])
    expect(await registered()).toEqual([empty])
  })

  it('replaces nothing on a board from before `path`, which reads one as a registration with nothing in it', async () => {
    const older = withoutPath(testBoard({ scheduler: fakeQueue().scheduler, access: [vercelProject({ project: 'prj_v0', can: 'all' })] }).fetch)
    const v0 = caller(older, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(older, () => deploymentToken('v0', 'prj_v0', 'production'))
    const watching = { url: 'https://v0.test/api/board', watch: { fix: { tail: 'feedback', when: 'matches' } }, sync: [] }
    expect((await v0('POST', '/watchers', watching)).status).toBe(200)
    expect(watcherStatuses(await conformance(asV0))).toEqual(['skipped', 'skipped', 'skipped'])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([watching])
    // An empty one fails the check, since the board took the path, and keeps where it's woken.
    expect((await v0('POST', '/watchers', { url: watching.url, watch: {} })).status).toBe(200)
    const report = await conformance(asV0)
    expect(report.checks.filter((check) => check.status === 'failed')).toMatchObject([
      { name: 'wakes by path only where its discovery says so, and only a Vercel project', detail: 'a path, on a board that wakes only urls: expected 501 no_wake_by_path, and it succeeded' },
    ])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([{ url: watching.url, watch: {} }])
  })

  it("passes a board that wakes by path, which a project registers on and gets back, and refuses anyone else's", async () => {
    const byPath = wakingByPath(testBoard({ scheduler: fakeQueue().scheduler, access: [vercelProject({ project: 'prj_v0', can: 'all' })] }).fetch)
    const v0 = caller(byPath, await deploymentToken('v0', 'prj_v0', 'production'))
    expect((await v0('POST', '/watchers', { path: '/api/board', watch: {} })).status).toBe(200)
    const report = await conformance(await clientAs(byPath, () => deploymentToken('v0', 'prj_v0', 'production')))
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed'])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, path: '/api/board', watch: {} }])
    // A person's token names no project to wake.
    const person = await conformance(await clientOf(wakingByPath(testBoard({ scheduler: fakeQueue().scheduler }).fetch)))
    expect(watcherStatuses(person)).toEqual(['passed', 'passed', 'passed'])
  })

  it("checks a preview's path with its branch, and gives the branch back", async () => {
    const byPath = wakingByPath(testBoard({ scheduler: fakeQueue().scheduler, access: [vercelProject({ project: 'prj_v0', can: 'all' })] }).fetch)
    const preview = caller(byPath, await deploymentToken('v0', 'prj_v0', 'preview'))
    expect((await preview('POST', '/watchers', { path: '/api/board', branch: 'jb/watchers', watch: {} })).status).toBe(200)
    const report = await conformance(await clientAs(byPath, () => deploymentToken('v0', 'prj_v0', 'preview')))
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed'])
    expect((await preview('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, path: '/api/board', branch: 'jb/watchers', watch: {} }])
  })

  it('reports schedules and files as not kept here on a board without a scheduler or a blob store', async () => {
    // A board on a2() with only its store answers 501 for each, and the kit reads that.
    const report = await conformance(await clientOf(testBoard({ blob: undefined }).fetch))
    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => check.status !== 'passed').map((check) => [check.group, check.status, check.detail])).toEqual([
      ['schedules', 'skipped', 'not kept here: this board has no scheduler: pass `scheduler` to `a2()` to send later'],
      ['attachments', 'skipped', 'not kept here: this board keeps no files: pass `blob` to `a2()`'],
    ])
  })

  it('fails a board that answers only part of the protocol any other way', async () => {
    // Schedules that are missing, not refused, and files the board takes but loses.
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const partial = broken(board.fetch, { request: (url) => url.pathname.endsWith('/schedules') && (url.pathname = url.pathname.replace(/schedules$/, 'nowhere')) })
    const report = await conformance(await clientOf(partial))
    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.group, check.name])).toEqual([
      ['schedules', 'schedules a reply, lists it, and cancels it'],
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
