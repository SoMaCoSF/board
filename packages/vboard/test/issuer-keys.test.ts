import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { board, vercelProject } from '../src/server/index.ts'
import { BOARD_URL, caller, GITHUB_ISS, PROJECT_ID, TEAM_ID, testAuth } from './harness.ts'

// Boards on the default issuers, so verification fetches keys from the network, which these tests stub.
const VERCEL_JWKS = 'https://oidc.vercel.com/.well-known/jwks'
const vercel = await generateKeyPair('RS256')
const attacker = await generateKeyPair('RS256')
const keys = { keys: [{ ...(await exportJWK(vercel.publicKey)), kid: 'vercel', alg: 'RS256' }] }

const token = (issuer: string, privateKey: CryptoKey) =>
  new SignJWT({ owner: 'acme', owner_id: 'team_acme', project: 'api', project_id: 'prj_api', environment: 'production' })
    .setProtectedHeader({ alg: 'RS256', kid: 'vercel' })
    .setIssuer(issuer)
    .setAudience(BOARD_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)

/** Answers like Vercel and GitHub do, a discovery document per issuer and the key set it names, and records each request. */
function network(discovery: (url: string) => Response | Promise<Response>) {
  const fetched: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    fetched.push(url)
    if (url.endsWith('/.well-known/jwks')) return Response.json(keys)
    return discovery(url)
  })
  return fetched
}

const vercelDiscovery = (url: string) =>
  Response.json({ jwks_uri: url.replace('/.well-known/openid-configuration', '/.well-known/jwks') })

afterEach(() => void vi.unstubAllGlobals())

describe('the keys a board fetches for Vercel tokens', () => {
  const access = [vercelProject({ project: 'prj_api', can: 'all' })]
  const configured = () => board({ store: memory(), url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, access })

  it("verifies a team issuer's token", async () => {
    network(vercelDiscovery)
    const me = await caller(configured().fetch, await token('https://oidc.vercel.com/acme', vercel.privateKey))('GET', '/me')
    expect({ status: me.status, actor: me.body?.actor }).toEqual({ status: 200, actor: 'vercel:project:prj_api:production' })
  })

  it('fetches only Vercel\'s one key set, whatever team issuers forged tokens name', async () => {
    const fetched = network(vercelDiscovery)
    const { fetch } = configured()
    for (let team = 0; team < 20; team++) {
      const forged = await token(`https://oidc.vercel.com/team-${team}`, attacker.privateKey)
      expect((await caller(fetch, forged)('GET', '/me')).status).toBe(401)
    }
    expect(fetched.filter((url) => url !== VERCEL_JWKS)).toEqual([])
    expect(fetched.length).toBeLessThanOrEqual(1)
  })
})

describe("the discovery a board runs for another issuer's keys", () => {
  const configured = () =>
    board({ store: memory(), url: BOARD_URL, project: { id: PROJECT_ID, teamId: TEAM_ID }, auth: { vercel: testAuth.vercel }, access: [] })

  it('runs once for concurrent tokens, and again after it fails', async () => {
    const fetched = network(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return new Response('unavailable', { status: 503 })
    })
    const { fetch } = configured()
    const forged = await token(GITHUB_ISS, attacker.privateKey)
    const statuses = await Promise.all(Array.from({ length: 10 }, () => caller(fetch, forged)('GET', '/me')))
    expect(statuses.map((response) => response.status)).toEqual(Array(10).fill(401))
    expect(fetched).toEqual([`${GITHUB_ISS}/.well-known/openid-configuration`])

    expect((await caller(fetch, forged)('GET', '/me')).status).toBe(401)
    expect(fetched).toHaveLength(2)
  })
})
