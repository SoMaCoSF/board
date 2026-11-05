import { describe, expect, it, vi } from 'vitest'
import { githubActions, oidc, vercelProject, type Known } from '../src/server/auth.ts'
import { caller, deploymentToken, oidcToken, OIDC_ISS, personToken, PROJECT_ID, TEAM_ID, testBoard, testKeys, workflowToken } from './harness.ts'

/** A person, and a caller with `token`, on one board: the person sets grants, the caller tries the board. */
async function setUp(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  const person = caller(board.fetch, await personToken())
  return { board, person, as: async (token: string | Promise<string>) => caller(board.fetch, await token) }
}

describe('grants', () => {
  it('lets in a workflow no rule names, as its can says, and keeps it out once revoked', async () => {
    const { person, as } = await setUp()
    const workflow = await as(workflowToken())
    expect((await workflow('GET', '/me')).status).toBe(403)

    const set = await person('POST', '/grants', { issuer: 'github', claims: { repository: 'basehub-ai/www' }, can: { 'ci/': ['read', 'post'] } })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ created: true, grant: { issuer: 'github', claims: { repository: 'basehub-ai/www' }, can: { 'ci/': ['read', 'post'] } } })

    expect((await workflow('POST', '/messages', { channel: 'ci', text: 'green' })).status).toBe(201)
    expect((await workflow('POST', '/messages', { channel: 'dev', text: 'not here' })).status).toBe(403)

    expect((await person('POST', `/grants/${set.body.grant.id}/revoke`, {})).body).toEqual({ revoked: true })
    expect((await workflow('POST', '/messages', { channel: 'ci', text: 'again' })).status).toBe(403)
  })

  it('lets every Vercel deployment it matches in, on any team, by its claims exactly', async () => {
    const { person, as } = await setUp()
    await person('POST', '/grants', { issuer: 'vercel', claims: { project_id: 'prj_other', environment: 'production', owner_id: 'team_other' }, can: { 'feedback/': ['post'] } })
    const theirs = await as(deploymentToken('other', 'prj_other', 'production', { teamId: 'team_other' }))
    expect((await theirs('POST', '/messages', { channel: 'feedback', text: 'from another team' })).status).toBe(201)
    // Its previews aren't the grant's: the environment is a claim like any other.
    const preview = await as(deploymentToken('other', 'prj_other', 'preview', { teamId: 'team_other' }))
    expect((await preview('POST', '/messages', { channel: 'feedback', text: 'from a preview' })).status).toBe(403)
  })

  it('lets every project on a team in, in the environment it names, and no other environment or team', async () => {
    const { person, as } = await setUp()
    const set = await person('POST', '/grants', { issuer: 'vercel', claims: { owner_id: TEAM_ID, environment: 'production' }, can: { 'feedback/': ['post'] } })
    expect(set.status).toBe(200)
    const post = async (token: Promise<string>) => (await (await as(token))('POST', '/messages', { channel: 'feedback', text: 'hi' })).status
    // Any of the team's projects, the ones made after the grant included.
    expect(await post(deploymentToken('web', 'prj_web', 'production'))).toBe(201)
    expect(await post(deploymentToken('docs', 'prj_docs', 'production'))).toBe(201)
    expect(await post(deploymentToken('web', 'prj_web', 'preview'))).toBe(403)
    expect(await post(deploymentToken('web', 'prj_partner', 'production', { teamId: 'team_partner' }))).toBe(403)
    // One project's custom environment is still that project's to name.
    expect((await person('POST', '/grants', { issuer: 'vercel', claims: { project_id: 'prj_web', environment: 'env_staging' } })).status).toBe(200)
  })

  it("adds up every grant that matches, and gives what a grant without can gives: read, post, react, and label", async () => {
    const { person, as } = await setUp()
    await person('POST', '/grants', { issuer: 'github', claims: { repository: 'basehub-ai/www' }, can: { 'ci/': ['read'] } })
    await person('POST', '/grants', { issuer: 'github', claims: { repository_id: '123456', event_name: ['push', 'schedule'] } })
    const me = await (await as(workflowToken()))('GET', '/me')
    expect(me.body.can).toEqual({ '*': ['read', 'post', 'react', 'label'] })
  })

  it("adds to what the code's rules give: a principal a rule matches gets the rule's and every matching grant's", async () => {
    const { person, as } = await setUp({ access: [githubActions({ repository: 'basehub-ai/www', can: { 'ci/': ['read'] } })] })
    const workflow = await as(workflowToken())
    const { body } = await person('POST', '/grants', { issuer: 'github', claims: { repository: 'basehub-ai/www' }, can: { 'deploys/': ['post'] } })
    expect((await workflow('GET', '/me')).body.can).toEqual({ 'ci/': ['read'], 'deploys/': ['post'] })
    // Revoking it leaves what the rule gives.
    await person('POST', `/grants/${body.grant.id}/revoke`, {})
    expect((await workflow('GET', '/me')).body.can).toEqual({ 'ci/': ['read'] })
  })

  it("never adds to the board's own deployments where it runs, or past a rule that refuses", async () => {
    vi.stubEnv('VERCEL_TARGET_ENV', '')
    vi.stubEnv('VERCEL_ENV', 'preview')
    try {
      const refuse = (principal: Known) => (principal.id.startsWith('github:') ? null : undefined)
      const { person, as } = await setUp({ access: [vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } }), refuse] })
      await person('POST', '/grants', { issuer: 'vercel', claims: { project_id: PROJECT_ID, environment: 'preview' }, can: 'all' })
      await person('POST', '/grants', { issuer: 'github', claims: { repository: 'basehub-ai/www' }, can: 'all' })
      expect((await (await as(deploymentToken('board', PROJECT_ID, 'preview')))('GET', '/me')).body.can).toEqual({ 'dev/': ['read'] })
      expect((await (await as(workflowToken()))('GET', '/me')).status).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('trusts an issuer once a grant names it, and only for tokens with its claims', async () => {
    const { person, as } = await setUp()
    const gitlab = await as(oidcToken())
    expect((await gitlab('GET', '/me')).status).toBe(401)
    await person('POST', '/grants', { issuer: OIDC_ISS, claims: { project_path: 'acme/api' }, can: { 'ci/': ['post'] } })
    expect((await gitlab('POST', '/messages', { channel: 'ci', text: 'from gitlab' })).status).toBe(201)
    const another = await as(oidcToken({ project_path: 'acme/other', sub: 'project_path:acme/other' }))
    expect((await another('POST', '/messages', { channel: 'ci', text: 'not granted' })).status).toBe(403)
  })

  it("finds a grant's issuer's keys by OIDC discovery, never by a redirect or on the board's own network", async () => {
    const ISS = 'https://idp.acme.dev'
    const DISCOVERY = `${ISS}/.well-known/openid-configuration`
    const { person, as } = await setUp()
    await person('POST', '/grants', { issuer: ISS, claims: { project_path: 'acme/api' }, can: { 'ci/': ['read'] } })
    const me = async () => (await (await as(oidcToken({}, ISS)))('GET', '/me')).status
    // The network as fetch sees it: a redirect is followed unless the request says otherwise.
    const asked: string[] = []
    let routes: Record<string, () => Response> = {}
    const network = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input)
      asked.push(url)
      const response = routes[url]?.() ?? new Response('not found', { status: 404 })
      const location = response.headers.get('location')
      if (location && response.status >= 300 && response.status < 400) {
        const mode = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
        if (mode === 'error') throw new TypeError('redirected')
        if (mode === 'follow') return network(new URL(location, url).href, init)
      }
      return response
    }
    vi.stubGlobal('fetch', network)
    try {
      const refused = {
        'a redirect to the metadata service': [{ [DISCOVERY]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }) }, 'http://169.254.169.254/latest/meta-data/'],
        'keys on its own network': [{ [DISCOVERY]: () => Response.json({ issuer: ISS, jwks_uri: 'https://keys.internal/jwks' }) }, 'https://keys.internal/jwks'],
        'keys over plain http': [{ [DISCOVERY]: () => Response.json({ issuer: ISS, jwks_uri: 'http://idp.acme.dev/jwks' }) }, 'http://idp.acme.dev/jwks'],
        'a document for another issuer': [{ [DISCOVERY]: () => Response.json({ issuer: 'https://evil.example', jwks_uri: `${ISS}/jwks` }) }, `${ISS}/jwks`],
      } as const
      for (const [why, [served, never]] of Object.entries(refused)) {
        routes = served
        expect([why, await me()]).toEqual([why, 401])
        expect([why, asked.includes(never)]).toEqual([why, false])
      }
      // Its own document, naming it and its keys, is how it's let in.
      routes = { [DISCOVERY]: () => Response.json({ issuer: ISS, jwks_uri: `${ISS}/jwks` }), [`${ISS}/jwks`]: () => Response.json(testKeys) }
      expect(await me()).toBe(200)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('is one grant per issuer and claims: setting it again changes its can', async () => {
    const { person } = await setUp()
    const claims = { project_id: 'prj_front', environment: ['production', 'preview'] }
    const first = await person('POST', '/grants', { issuer: 'vercel', claims, can: { 'feedback/': ['post'] } })
    // The same claims in another order, and a list in another order, are the same grant.
    const again = await person('POST', '/grants', { issuer: 'vercel', claims: { environment: ['preview', 'production'], project_id: 'prj_front' }, can: ['read'] })
    expect(again.body).toMatchObject({ created: false, grant: { id: first.body.grant.id, can: { '*': ['read'] } } })
    expect((await person('GET', '/grants')).body.grants).toHaveLength(1)
  })

  it('needs manage in every channel to set, list, or revoke one', async () => {
    const { person, as } = await setUp({ access: [githubActions({ repository: 'basehub-ai/www', can: { '*': 'all', 'security/': [] } })] })
    const { body } = await person('POST', '/grants', { issuer: 'github', claims: { repository: 'acme/web' } })
    const workflow = await as(workflowToken())
    expect((await workflow('GET', '/grants')).status).toBe(403)
    expect((await workflow('POST', '/grants', { issuer: 'github', claims: { repository: 'acme/other' } })).status).toBe(403)
    expect((await workflow('POST', `/grants/${body.grant.id}/revoke`, {})).status).toBe(403)
  })

  it('refuses a grant that would let in more than it names', async () => {
    const { person } = await setUp()
    const refused = async (grant: unknown) => {
      const { status, body } = await person('POST', '/grants', grant)
      return [status, body.error?.code]
    }
    const invalid = [400, 'invalid_grant']
    // Vercel and GitHub sign tokens for everyone they serve: a grant names who, and a preview says so outright.
    expect(await refused({ issuer: 'vercel', claims: { project_id: 'prj_front' } })).toEqual(invalid)
    expect(await refused({ issuer: 'vercel', claims: { owner_id: TEAM_ID } })).toEqual(invalid)
    // Neither a project nor a team would be every project on Vercel, and a custom environment's ID is one project's.
    expect(await refused({ issuer: 'vercel', claims: { environment: 'production' } })).toEqual(invalid)
    expect(await refused({ issuer: 'vercel', claims: { owner_id: TEAM_ID, environment: 'env_staging' } })).toEqual(invalid)
    expect(await refused({ issuer: 'vercel', claims: { owner_id: TEAM_ID, environment: ['production', 'env_staging'] } })).toEqual(invalid)
    expect(await refused({ issuer: 'github', claims: { event_name: 'push' } })).toEqual(invalid)
    expect(await refused({ issuer: OIDC_ISS, claims: {} })).toEqual(invalid)
    // Its keys are fetched from the issuer, so never from the board's own network.
    expect(await refused({ issuer: 'https://169.254.169.254', claims: { sub: 'x' } })).toEqual(invalid)
    expect(await refused({ issuer: 'https://ci.internal/oidc', claims: { sub: 'x' } })).toEqual(invalid)
    expect(await refused({ issuer: 'http://gitlab.com', claims: { sub: 'x' } })).toEqual(invalid)
    expect(await refused({ issuer: 'https://oidc.vercel.com/acme', claims: { project_id: 'prj_front', environment: 'production' } })).toEqual(invalid)
    expect(await refused({ issuer: 'github', claims: { repository: 'acme/web' }, can: { 'ci/*': ['post'] } })).toEqual(invalid)
    expect((await person('GET', '/grants')).body.grants).toEqual([])
  })

  it("refuses an issuer that names the same principals as one a grant trusts", async () => {
    const board = testBoard({ access: [] })
    const person = caller(board.fetch, await personToken())
    await person('POST', '/grants', { issuer: OIDC_ISS, claims: { project_path: 'acme/api' } })
    const { status, body } = await person('POST', '/grants', { issuer: `${OIDC_ISS}/`, claims: { project_path: 'acme/api' } })
    expect([status, body.error.code]).toEqual([400, 'invalid_grant'])
  })

  it("refuses an issuer that names the same principals as one the code's rules trust", async () => {
    const board = testBoard({ access: [oidc({ issuer: OIDC_ISS, claims: { project_path: 'acme/api' }, can: ['read'] })] })
    const person = caller(board.fetch, await personToken())
    const { status, body } = await person('POST', '/grants', { issuer: `${OIDC_ISS}/`, claims: { project_path: 'acme/other' } })
    expect([status, body.error.code]).toEqual([400, 'invalid_grant'])
  })

  it('keeps none on a board whose access is one function, which decides alone', async () => {
    const board = testBoard({ access: async (principal) => (principal.kind === 'person' ? 'all' : null) })
    const person = caller(board.fetch, await personToken())
    const { status, body } = await person('POST', '/grants', { issuer: 'github', claims: { repository: 'acme/web' } })
    expect([status, body.error.code]).toEqual([501, 'no_grants'])
  })
})
