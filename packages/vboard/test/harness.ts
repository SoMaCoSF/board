import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { vi, expect } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { board, type BoardOptions } from '../src/server/index.ts'

export const BOARD_URL = 'http://board.test/api/board'
export const PROJECT_ID = 'prj_board'
export const TEAM_ID = 'team_test'
export const VERCEL_ISS = 'https://oidc.vercel.com/test'
export const GITHUB_ISS = 'https://token.actions.githubusercontent.com'
/** Some other OIDC issuer, for `oidc()`. */
export const OIDC_ISS = 'https://gitlab.test'

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }
const jwks = createLocalJWKSet({ keys: [jwk] })

/** The test issuers, to combine with other auth options. */
export const testAuth = {
  vercel: { issuer: VERCEL_ISS, jwks },
  github: { issuer: GITHUB_ISS, jwks },
  oidc: { [OIDC_ISS]: jwks },
}

/**
 * A clock that keeps real time and can skip ahead. A2 holds a failed event back
 * before retrying it (one second, doubling to 30) by its store's clock, so a
 * test that drives retries skips the hold instead of waiting it out.
 */
export function testClock() {
  let ahead = 0
  return {
    now: () => new Date(Date.now() + ahead),
    /** Past any retry hold. */
    skip: (ms = 30_000) => void (ahead += ms),
  }
}

/** A board on a memory store whose tokens come from a local test issuer. */
export function testBoard(options: Partial<Omit<BoardOptions, 'remote'>> = {}) {
  const clock = testClock()
  const store = memory({ clock })
  const created = board({
    store,
    url: BOARD_URL,
    project: { id: PROJECT_ID, teamId: TEAM_ID },
    auth: testAuth,
    ...options,
  })
  /**
   * Lets a failed event's next attempt run now, once no attempt is running on
   * `session`: skipping past a running attempt's claim would let a drain take it
   * over, and run the event twice at once.
   */
  const skipHold = async (server: { contract: { name: string } }, session: string) => {
    // Skipping the clock lapses every claim in the store, so nothing may be running on the board either:
    // a delivery in flight there would be taken over, and post twice.
    const sessions = [`${server.contract.name}\u001f${session}`, 'vboard\u001fboard']
    await vi.waitFor(async () => {
      for (const at of sessions) {
        const cursors = await store.log!.cursors(at)
        expect(cursors.filter((cursor) => cursor.claimHolder !== null)).toEqual([])
      }
    })
    clock.skip()
  }
  return Object.assign(created, { clock, skipHold })
}

async function sign(claims: Record<string, unknown>, issuer: string, audience = BOARD_URL) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

/** A person: a development token for the board's own project. */
export const personToken = (userId = 'u_julian', audience?: string) =>
  sign(
    {
      sub: `owner:test:project:board:environment:development`,
      owner: 'test',
      owner_id: TEAM_ID,
      project: 'board',
      project_id: PROJECT_ID,
      environment: 'development',
      user_id: userId,
    },
    VERCEL_ISS,
    audience,
  )

/** A deployment of some Vercel project. */
export const deploymentToken = (
  project = 'marketing',
  projectId = 'prj_marketing',
  environment = 'production',
  options: { teamId?: string; audience?: string } = {},
) =>
  sign(
    {
      sub: `owner:test:project:${project}:environment:${environment}`,
      owner: 'test',
      owner_id: options.teamId ?? TEAM_ID,
      project,
      project_id: projectId,
      environment,
    },
    VERCEL_ISS,
    options.audience,
  )

/** A GitHub Actions run. */
export const workflowToken = (claims: Record<string, unknown> = {}) =>
  sign(
    {
      repository: 'basehub-ai/www',
      repository_id: '123456',
      event_name: 'push',
      ref: 'refs/heads/main',
      workflow_ref: 'basehub-ai/www/.github/workflows/deploy.yml@refs/heads/main',
      ...claims,
    },
    GITHUB_ISS,
  )

/** A token from another OIDC issuer, GitLab's shape by default. */
export const oidcToken = (claims: Record<string, unknown> = {}, issuer = OIDC_ISS) =>
  sign({ sub: 'project_path:acme/api:ref_type:branch:ref:main', project_path: 'acme/api', ref: 'main', ...claims }, issuer)

/** Calls the board in-process, like a client would over HTTP. */
export function caller(handler: (request: Request) => Promise<Response>, token: string, headers: Record<string, string> = {}) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await handler(
      new Request(`${BOARD_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
}
