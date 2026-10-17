import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { memory } from '../src/store/memory.ts'
import { describe, expect, it } from 'vitest'
import { board, vercel } from '../src/server/index.ts'
import { BOARD_URL, caller, PROJECT_ID, TEAM_ID, testBoard } from './harness.ts'

// Vercel signs every team's tokens, each under its own issuer
// (`https://oidc.vercel.com/<team>`), and production accepts any of them.
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'vercel', alg: 'RS256' }] })
const auth = { vercel: { issuer: /^https:\/\/oidc\.vercel\.com\/[a-z0-9-]+$/, jwks } }

/** A production deployment of `project` on some team. */
const deployment = (team: string, teamId: string, project: string, projectId: string, audience = BOARD_URL) =>
  new SignJWT({
    sub: `owner:${team}:project:${project}:environment:production`,
    owner: team,
    owner_id: teamId,
    project,
    project_id: projectId,
    environment: 'production',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'vercel' })
    .setIssuer(`https://oidc.vercel.com/${team}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

const ours = () => deployment('test', TEAM_ID, 'marketing', 'prj_marketing')
const theirs = () => deployment('attacker', 'team_attacker', 'marketing', 'prj_attacker')
const trustedSources = [vercel({ project: 'marketing', environments: ['production'] })]

describe('a trusted Vercel project named without its team', () => {
  const configured = () => testBoard({ auth, trustedSources })

  it("trusts the board's own team's project of that name", async () => {
    const me = await caller(configured().fetch, await ours())('GET', '/me')
    expect({ status: me.status, actor: me.body?.actor }).toEqual({
      status: 200,
      actor: 'vercel:project:prj_marketing:production',
    })
  })

  it("doesn't trust another team's project that took the same name", async () => {
    const call = caller(configured().fetch, await theirs())
    expect((await call('GET', '/me')).status).toBe(403)
    expect((await call('POST', '/messages', { channel: 'general', text: 'deploy approved' })).status).toBe(403)
  })

  it('trusts a project named by ID on any team, since IDs are unique', async () => {
    const { fetch } = testBoard({ auth, trustedSources: [vercel({ project: 'prj_attacker' })] })
    expect((await caller(fetch, await theirs())('GET', '/me')).status).toBe(200)
  })

  it('learns its team from the platform token for its own project', async () => {
    const { fetch } = board({ store: memory(), url: BOARD_URL, project: { id: PROJECT_ID }, auth, trustedSources })
    const call = async (token: string, platform?: string) =>
      (await caller(fetch, token, platform ? { 'x-vercel-oidc-token': platform } : {})('GET', '/me')).status
    // With no team to scope it to, a name matches nothing.
    expect(await call(await ours())).toBe(403)
    // A token for some other project says nothing about the board's team.
    expect(await call(await theirs(), await deployment('attacker', 'team_attacker', 'x', 'prj_x', 'https://vercel.com/attacker'))).toBe(403)
    const platform = await deployment('test', TEAM_ID, 'board', PROJECT_ID, 'https://vercel.com/test')
    expect(await call(await ours(), platform)).toBe(200)
    expect(await call(await theirs(), platform)).toBe(403)
  })
})

describe('a trusted Vercel team: vercel() without a project', () => {
  const preview = () =>
    new SignJWT({
      sub: 'owner:test:project:docs:environment:preview',
      owner: 'test',
      owner_id: TEAM_ID,
      project: 'docs',
      project_id: 'prj_docs',
      environment: 'preview',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'vercel' })
      .setIssuer('https://oidc.vercel.com/test')
      .setAudience(BOARD_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)

  it("trusts every project on the board's team, and none on another", async () => {
    const { fetch } = testBoard({ auth, trustedSources: [vercel()] })
    const me = await caller(fetch, await ours())('GET', '/me')
    expect({ status: me.status, actor: me.body?.actor }).toEqual({ status: 200, actor: 'vercel:project:prj_marketing:production' })
    expect((await caller(fetch, await deployment('test', TEAM_ID, 'docs', 'prj_docs'))('GET', '/me')).status).toBe(200)
    expect((await caller(fetch, await theirs())('GET', '/me')).status).toBe(403)
  })

  it('trusts the team it names, and the environments it lists', async () => {
    const named = testBoard({ auth, trustedSources: [vercel({ team: 'attacker' })] })
    expect((await caller(named.fetch, await theirs())('GET', '/me')).status).toBe(200)
    expect((await caller(named.fetch, await ours())('GET', '/me')).status).toBe(403)

    const production = testBoard({ auth, trustedSources: [vercel({ environments: ['production'] })] })
    expect((await caller(production.fetch, await ours())('GET', '/me')).status).toBe(200)
    expect((await caller(production.fetch, await preview())('GET', '/me')).status).toBe(403)
  })

  it("matches nothing when the board doesn't know its team", async () => {
    const { fetch } = board({ store: memory(), url: BOARD_URL, project: { id: PROJECT_ID }, auth, trustedSources: [vercel()] })
    expect((await caller(fetch, await ours())('GET', '/me')).status).toBe(403)
  })
})
