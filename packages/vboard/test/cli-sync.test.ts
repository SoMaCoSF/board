import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { http as httpBackend } from '../src/backend-http/index.ts'
import { slack, type SlackClient } from '../src/sync/slack.ts'
import { CLI, tmp } from './cli-harness.ts'
import { bearer, caller, deploymentToken, personToken, PROJECT_ID, signedInHome, TEAM_ID, testAuth, testBoard } from './harness.ts'
import { serve } from './http.ts'
import { fakePlatform, withSlackClient } from './sync-fixtures.ts'

/**
 * The CLI on a project whose board is on http() and syncs Slack, over real HTTP: the team's board on
 * a2() keeps the log, the project's runs the sync, and the repo links the team's board.
 */
let team: ReturnType<typeof testBoard>
let project: ReturnType<typeof board>
let backend: ReturnType<typeof httpBackend>
let servers: Awaited<ReturnType<typeof serve>>[] = []
let teamUrl: string
let projectUrl: string
let env: NodeJS.ProcessEnv
const s = fakePlatform('slack')

beforeAll(async () => {
  const teamServer = await serve((request) => team.fetch(request))
  const projectServer = await serve((request) => project.fetch(request))
  servers = [teamServer, projectServer]
  teamUrl = `${teamServer.origin}/api/board`
  projectUrl = `${projectServer.origin}/api/board`
  team = testBoard({ url: teamUrl, access: [vercelProject({ project: 'prj_support', can: 'all' })] })
  backend = httpBackend(teamUrl, { fetch: bearer(globalThis.fetch, () => deploymentToken('support', 'prj_support', 'production', { audience: teamUrl })) })
  project = board({
    backend,
    url: projectUrl,
    sync: { slack: slack({ adapter: s.adapter, channels: { C1: 'firehose' } }) },
  })
  // Its registration tells the team's board it syncs Slack, as its first request would.
  await backend.registerWatchers()
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|VBOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)),
  )
  // Linked to the team's board, signed in as `vercel login` leaves it: no token is handed to the CLI.
  env = { ...clean, VBOARD_URL: teamUrl, VBOARD_HANDLE: 'julian', HOME: await tmp('vboard-home-'), XDG_CONFIG_HOME: await signedInHome([teamUrl]) }
})

afterAll(async () => {
  backend.close()
  await Promise.all(servers.map((server) => server.close()))
})

function vb(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}

describe('the CLI on a project whose board is on http()', () => {
  it("links a Slack account on the team's board, which the project's sync links when the code comes in", async () => {
    const linked = await vb(['identity', 'link', 'slack', '--no-wait'])
    expect(linked).toMatchObject({ code: 0, stderr: '' })
    const code = linked.stdout.match(/vb-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0]
    expect(code).toBeDefined()

    // The team's board issued it. Posted from that Slack account, the project's sync redeems it there.
    await project.fetch(
      new Request(`${projectUrl}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', threadId: 'slack:C1:100', id: '100', text: code, user: 'U_JULIAN', name: 'jb' }),
      }),
    )
    const julian = caller(team.fetch, await personToken('u_julian', teamUrl))
    await vi.waitFor(async () => expect((await julian('GET', '/identity')).body.links).toEqual([expect.objectContaining({ actor: 'slack:user:U_JULIAN', method: 'code' })]))
    await vi.waitFor(() => expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: '100', emoji: 'check', added: true }]))

    // The CLI reads it there too, and posts there.
    const listed = await vb(['identity'])
    expect(listed).toMatchObject({ code: 0, stderr: '' })
    expect(listed.stdout).toContain('slack:user:U_JULIAN  by code')
    expect(await vb(['post', 'firehose', 'from the CLI'])).toMatchObject({ code: 0, stderr: '' })
    expect((await julian('GET', '/messages?channel=firehose')).body.messages.map((m: { text: string }) => m.text)).toEqual(['from the CLI'])
  }, 20_000)
})

/** Slack's Web API, as the app reads #project-vercel-kit: two messages, the older with replies. */
const kit = {
  conversations: {
    list: async () => ({ channels: [{ id: 'CKIT', name: 'project-vercel-kit', is_member: true }] }),
    info: async () => ({ channel: { id: 'CKIT', name: 'project-vercel-kit', is_member: true } }),
    join: async () => ({}),
    history: async () => ({
      messages: [
        { ts: '1791399999.000002', user: 'U_JB', text: 'latest' },
        { ts: '1791389583.493629', user: 'U_ADA', text: 'kit maps slack users to vercel ids' },
      ],
      has_more: false,
    }),
    replies: async () => ({ messages: [], has_more: false }),
  },
  users: { info: async ({ user }: { user: string }) => ({ user: { id: user, real_name: user === 'U_ADA' ? 'Ada Lovelace' : 'Julian' } }) },
}

describe('the CLI on a board that runs a sync', () => {
  const p = fakePlatform('slack', withSlackClient(kit, false))
  let synced: ReturnType<typeof testBoard>
  let server: Awaited<ReturnType<typeof serve>>
  let url: string
  let home: NodeJS.ProcessEnv
  beforeAll(async () => {
    server = await serve((request) => synced.fetch(request))
    url = `${server.origin}/api/board`
    synced = testBoard({ url, sync: { slack: slack({ adapter: p.adapter, client: async () => kit as unknown as SlackClient, channels: { C1: 'firehose' } }) } })
    home = { ...env, VBOARD_URL: url, XDG_CONFIG_HOME: await signedInHome([url]) }
  })
  afterAll(() => server.close())

  const on = (args: string[], url?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: url ? { ...env, VBOARD_URL: url } : home })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      child.stdin.end()
    })

  it('reads a source and shows typing through its sync, and a board that runs none says so', async () => {
    const read = await on(['sources', 'slack', 'read', '#project-vercel-kit', '--json'])
    expect(read).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(read.stdout)).toMatchObject({ channel: 'CKIT', name: 'project-vercel-kit', messages: [{ text: 'kit maps slack users to vercel ids' }, { text: 'latest' }] })

    // A thread that came from Slack: typing shows in it there.
    await synced.fetch(
      new Request(`${url}/webhooks/slack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', threadId: 'slack:C1:200', id: '200', text: 'export is broken', user: 'U_ADA' }),
      }),
    )
    const julian = caller(synced.fetch, await personToken('u_julian', url))
    await vi.waitFor(async () => expect((await julian('GET', '/messages?channel=firehose')).body.messages).toHaveLength(1))
    const [root] = (await julian('GET', '/messages?channel=firehose')).body.messages
    expect(await on(['typing', root.id, 'running', 'tests…', '--json'])).toMatchObject({ code: 0, stdout: `${JSON.stringify({ targets: ['slack:C1:200'] })}\n`, stderr: '' })
    expect([p.typing, p.statuses]).toEqual([['slack:C1:200'], ['running tests…']])

    // The team's board doesn't run the project's Slack: only the board that does reads it.
    expect(await on(['sources', 'slack', 'read', '#project-vercel-kit'], teamUrl)).toMatchObject({
      code: 1,
      stderr: "error: this board doesn't run sync entry slack: read it where its sync runs\n",
    })
  }, 20_000)
})
