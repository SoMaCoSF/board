import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercelProject } from '../src/access/index.ts'
import { http as httpBackend } from '../src/backend-http/index.ts'
import { slack } from '../src/sync/slack.ts'
import { CLI, tmp } from './cli-harness.ts'
import { bearer, caller, deploymentToken, personToken, PROJECT_ID, signedInHome, TEAM_ID, testAuth, testBoard } from './harness.ts'
import { serve } from './http.ts'
import { fakePlatform } from './sync-fixtures.ts'

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
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    auth: testAuth,
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
    expect(s.reactions).toEqual([{ threadId: 'slack:C1:100', messageId: '100', emoji: 'check', added: true }])

    // The CLI reads it there too, and posts there.
    const listed = await vb(['identity'])
    expect(listed).toMatchObject({ code: 0, stderr: '' })
    expect(listed.stdout).toContain('slack:user:U_JULIAN  by code')
    expect(await vb(['post', 'firehose', 'from the CLI'])).toMatchObject({ code: 0, stderr: '' })
    expect((await julian('GET', '/messages?channel=firehose')).body.messages.map((m: { text: string }) => m.text)).toEqual(['from the CLI'])
  }, 20_000)
})
