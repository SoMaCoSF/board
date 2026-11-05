import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vb as embedded } from '../src/cli/embedded.ts'
import { url, useBoard, vb } from './cli-harness.ts'
import { deploymentToken, PROJECT_ID, TEAM_ID, testBoard } from './harness.ts'

useBoard()

/** The claims of the board's grants, as `grants --json` lists them. */
const claims = async () => (JSON.parse((await vb(['grants', '--json'])).stdout).grants as { claims: unknown }[]).map((grant) => grant.claims)

/** Revokes every grant. */
async function revokeAll() {
  for (const { id } of JSON.parse((await vb(['grants', '--json'])).stdout).grants as { id: string }[]) await vb(['grants', 'revoke', id])
}

describe('cli grants for Vercel projects', () => {
  // Each test starts with no grants, whatever the one before left.
  beforeEach(revokeAll, 30_000)

  it("grants every project on the board's team, or one, in an environment, and lists them in words", async () => {
    const every = await vb(['grants', 'create', 'vercel', '--projects', '--environment', 'production'])
    expect(every).toMatchObject({ code: 0, stdout: expect.stringMatching(/^granted g\d+\n$/), stderr: '' })
    expect((await vb(['grants', 'create', 'vercel', '--project', 'prj_front', '--environment', 'preview', '--can', 'feedback/=post'])).code).toBe(0)
    expect((await vb(['grants', 'create', 'vercel', '--projects', '--environment', 'production', '--claim', 'owner_id=team_partner'])).code).toBe(0)
    expect(await claims()).toEqual([
      { environment: 'production', owner_id: TEAM_ID },
      { environment: 'preview', owner_id: TEAM_ID, project_id: 'prj_front' },
      { environment: 'production', owner_id: 'team_partner' },
    ])
    const ids = JSON.parse((await vb(['grants', '--json'])).stdout).grants.map((grant: { id: string }) => grant.id)
    // The board's own team goes unsaid; another team is named.
    expect((await vb(['grants'])).stdout).toBe(
      [
        `${ids[0]}  vercel  every project, production                  *=read,post,react,label`,
        `${ids[1]}  vercel  prj_front, preview                         feedback/=post`,
        `${ids[2]}  vercel  every project on team_partner, production  *=read,post,react,label`,
        '',
      ].join('\n'),
    )
    // The first lets in a project of the team's that no grant names.
    const web = { BOARD_TOKEN: await deploymentToken('web', 'prj_web', 'production', { audience: url }) }
    expect((await vb(['post', 'dev', 'from web'], web)).code).toBe(0)
    await revokeAll()
    expect((await vb(['post', 'dev', 'not anymore'], web)).code).toBe(1)
  }, 30_000)

  it('keeps --claim as written, filling in no team', async () => {
    expect((await vb(['grants', 'create', 'vercel', '--claim', 'project_id=prj_front', '--claim', 'environment=production'])).code).toBe(0)
    expect(await claims()).toEqual([{ environment: 'production', project_id: 'prj_front' }])
  }, 30_000)

  it('says what a vercel grant needs before it asks the board', async () => {
    const misuse = async (args: string[]) => {
      const ran = await vb(['grants', 'create', ...args])
      return [ran.code, ran.stderr.split('\n')[0]]
    }
    expect(await misuse(['vercel', '--projects', '--project', 'prj_front', '--environment', 'production'])).toEqual([
      2,
      'error: --projects is every project on the team, and --project one of them: pass one.',
    ])
    expect(await misuse(['vercel', '--projects', '--claim', 'project_id=prj_front', '--environment', 'production'])).toEqual([
      2,
      'error: --projects is every project on the team, so it takes no --claim project_id.',
    ])
    expect(await misuse(['vercel', '--project', 'front', '--environment', 'production'])).toEqual([
      2,
      "error: --project takes a project's ID, like prj_123, and front isn't one. The project's settings show it.",
    ])
    expect(await misuse(['vercel', '--projects'])).toEqual([2, 'error: Missing the environment its deployments run in: pass --environment production, preview, or development.'])
    expect(await misuse(['vercel', '--environment', 'production'])).toEqual([
      2,
      "error: Missing the projects to let in: pass --projects for every project on the board's team, or --project with one's ID.",
    ])
    expect(await misuse(['github', '--projects', '--claim', 'repository=acme/web'])).toEqual([
      2,
      "error: --projects, --project, and --environment are for vercel grants: name github's claims with --claim name=value.",
    ])
    expect(await claims()).toEqual([])
  }, 30_000)

  it("changes a grant's can by its ID, keeping who it lets in, and points to the grants for one it can't find", async () => {
    const granted = await vb(['grants', 'create', 'vercel', '--projects', '--environment', 'production', '--can', 'dev/=read'])
    const id = granted.stdout.trim().split(' ')[1]!
    const web = { BOARD_TOKEN: await deploymentToken('web', 'prj_web', 'production', { audience: url }) }
    expect((await vb(['post', 'dev', 'not yet'], web)).code).toBe(1)

    expect(await vb(['grants', 'update', id, '--can', 'dev/=read,post'])).toEqual({ code: 0, stdout: `updated ${id}\n`, stderr: '' })
    expect(JSON.parse((await vb(['grants', '--json'])).stdout).grants).toMatchObject([
      { id, issuer: 'vercel', claims: { environment: 'production', owner_id: TEAM_ID }, can: { 'dev/': ['read', 'post'] } },
    ])
    expect((await vb(['post', 'dev', 'now'], web)).code).toBe(0)

    expect(await vb(['grants', 'update', 'g999', '--can', 'dev/=read'])).toEqual({
      code: 1,
      stdout: '',
      stderr: "error: Couldn't find grant g999.\n\n  See the board's grants:\n    vb grants\n",
    })
    const bare = await vb(['grants', 'update', id])
    expect([bare.code, bare.stderr.split('\n')[0]]).toEqual([2, `error: Missing what ${id} lets them do now: pass --can, like --can ci/=read,post.`])
    expect(JSON.parse((await vb(['grants', '--json'])).stdout).grants).toHaveLength(1)
  }, 30_000)

  it("asks for the team where the board doesn't say which it's on", async () => {
    vi.stubEnv('VERCEL_ORG_ID', '')
    try {
      // A board that knows its project and not its team, outside a linked directory.
      const team = testBoard({ project: { id: PROJECT_ID } })
      expect((await team.discovery()).team_id).toBeNull()
      const ran = await embedded(team, ['grants', 'create', 'vercel', '--projects', '--environment', 'production'])
      expect(ran).toEqual({
        code: 2,
        stdout: '',
        stderr: "error: Can't tell which team the board is on, to keep the grant to it.\n\n  Name the team:\n    vb grants create vercel --projects --environment production --claim 'owner_id=<TEAM_ID>'\n",
      })
      expect(await team.grants()).toEqual([])
      // Naming it is enough.
      expect((await embedded(team, ['grants', 'create', 'vercel', '--projects', '--environment', 'production', '--claim', 'owner_id=team_acme'])).code).toBe(0)
      expect((await team.grants()).map((grant) => grant.claims)).toEqual([{ environment: 'production', owner_id: 'team_acme' }])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
