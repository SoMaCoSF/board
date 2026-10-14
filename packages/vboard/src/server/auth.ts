import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import { unauthorized, forbidden } from './errors.ts'

export type Capability = 'post' | 'react' | 'label' | 'sync'

/** `external`: a platform user writing through sync (`slack:user:U0456`). A local board's people are `local:user:<name>`. */
export type PrincipalKind = 'person' | 'deployment' | 'workflow' | 'external'

export type Principal = {
  /** `vercel:user:<id>`, `vercel:project:<id>:<env>`, `github:repo:<id>`. */
  id: string
  kind: PrincipalKind
  /** The default handle; a person's is replaced by the handle their CLI sends. */
  handle: string
  can: 'all' | ReadonlySet<Capability>
  expiresAt: Date | null
  /** The board's own deployment, in the board's own environment: the one principal that may write as a declared agent. */
  own?: true
}

type Claims = JWTPayload & Record<string, unknown>

export type TrustedSource = {
  issuer: 'vercel' | 'github'
  matches(claims: Claims): boolean
  can?: readonly Capability[]
}

const oneOf = (value: unknown, allowed: string | readonly string[] | undefined) =>
  allowed === undefined ||
  (typeof value === 'string' && (typeof allowed === 'string' ? [allowed] : allowed).includes(value))

/** Trust another Vercel project's deployments. Matches project by name or ID. */
export function vercel(options: {
  project: string
  team?: string
  environments?: readonly string[]
  can?: readonly Capability[]
}): TrustedSource {
  return {
    issuer: 'vercel',
    can: options.can,
    matches: (claims) =>
      (claims.project === options.project || claims.project_id === options.project) &&
      (options.team === undefined ||
        claims.owner === options.team ||
        claims.owner_id === options.team) &&
      oneOf(claims.environment, options.environments),
  }
}

/**
 * Trust a GitHub Actions workflow. A `pull_request` run's token carries
 * `ref: refs/pull/<n>/merge`, so match those on `event` and `workflow`, not `ref`.
 */
export function githubActions(options: {
  repository: string
  event?: string | readonly string[]
  workflow?: string
  ref?: string
  can?: readonly Capability[]
}): TrustedSource {
  return {
    issuer: 'github',
    can: options.can,
    matches: (claims) =>
      claims.repository === options.repository &&
      oneOf(claims.event_name, options.event) &&
      (options.ref === undefined || claims.ref === options.ref) &&
      (options.workflow === undefined ||
        (typeof claims.workflow_ref === 'string' &&
          claims.workflow_ref.startsWith(`${options.repository}/${options.workflow}@`))),
  }
}

export type IssuerConfig = {
  /** Accepted `iss` values. */
  issuer: string | RegExp
  /** Key source; defaults to the issuer's published JWKS. */
  jwks?: JWTVerifyGetKey
}

/** Tests point these at a local issuer; production uses the defaults. */
export type AuthOptions = {
  vercel?: IssuerConfig
  github?: IssuerConfig
  /**
   * A local board's own issuer (`vb serve`): its tokens' `sub` is a person on
   * this machine, `local:user:<sub>`, with full access. Its keys are never
   * fetched, so `jwks` is required.
   */
  local?: { issuer: string; jwks: JWTVerifyGetKey }
}

const VERCEL_ISSUER = /^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9-]+)?$/
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

const issuerMatches = (iss: string, accepted: string | RegExp) =>
  typeof accepted === 'string' ? iss === accepted : accepted.test(iss)

const remoteKeys = new Map<string, JWTVerifyGetKey>()

async function keysFor(iss: string): Promise<JWTVerifyGetKey> {
  const cached = remoteKeys.get(iss)
  if (cached) return cached
  const response = await fetch(`${iss}/.well-known/openid-configuration`)
  if (!response.ok) throw unauthorized(`cannot load keys for issuer ${iss}`)
  const { jwks_uri } = (await response.json()) as { jwks_uri: string }
  const keys = createRemoteJWKSet(new URL(jwks_uri))
  remoteKeys.set(iss, keys)
  return keys
}

export function createVerifier(options: {
  projectId: () => Promise<string | null>
  /** The board's own environment (`production`, `preview`), or null when it can't tell. */
  environment?: () => string | null
  trustedSources: readonly TrustedSource[]
  auth?: AuthOptions
}) {
  const vercelIssuer = options.auth?.vercel ?? { issuer: VERCEL_ISSUER }
  const githubIssuer = options.auth?.github ?? { issuer: GITHUB_ISSUER }

  const fromSource = (
    issuer: TrustedSource['issuer'],
    claims: Claims,
  ): ReadonlySet<Capability> | 'all' | null => {
    const source = options.trustedSources.find(
      (candidate) => candidate.issuer === issuer && candidate.matches(claims),
    )
    if (!source) return null
    return source.can ? new Set(source.can) : 'all'
  }

  return async function verify(token: string, audience: string): Promise<Principal> {
    let iss: string
    try {
      iss = String(decodeJwt(token).iss ?? '')
    } catch {
      throw unauthorized('malformed token')
    }

    const local = options.auth?.local
    if (local && iss === local.issuer) return localPerson(token, local, audience)

    const isVercel = issuerMatches(iss, vercelIssuer.issuer)
    const isGitHub = !isVercel && issuerMatches(iss, githubIssuer.issuer)
    if (!isVercel && !isGitHub) throw unauthorized(`untrusted issuer: ${iss || '(none)'}`)
    const config = isVercel ? vercelIssuer : githubIssuer

    let claims: Claims
    try {
      const keys = config.jwks ?? (await keysFor(iss))
      ;({ payload: claims } = (await jwtVerify(token, keys, { issuer: iss, audience })) as {
        payload: Claims
      })
    } catch (error) {
      if ((error as { status?: number }).status === 401) throw error
      throw unauthorized(`invalid token: ${(error as Error).message}`)
    }
    const expiresAt = claims.exp ? new Date(claims.exp * 1000) : null

    if (isGitHub) {
      const can = fromSource('github', claims)
      if (!can) throw forbidden(`workflow is not a trusted source: ${String(claims.repository)}`)
      return {
        id: `github:repo:${String(claims.repository_id)}`,
        kind: 'workflow',
        handle: String(claims.repository),
        can,
        expiresAt,
      }
    }

    const environment = String(claims.environment ?? '')
    const project = String(claims.project ?? '')
    const ownProject = (await options.projectId()) ?? null
    if (ownProject !== null && claims.project_id === ownProject) {
      if (environment === 'development') {
        // A development token minted with someone's Vercel login carries their user ID.
        if (typeof claims.user_id !== 'string')
          throw unauthorized('development token without user_id')
        return {
          id: `vercel:user:${claims.user_id}`,
          kind: 'person',
          handle: `user-${claims.user_id.slice(0, 6).toLowerCase()}`,
          can: 'all',
          expiresAt,
        }
      }
      // A preview deployment can't write as the production board's agents, and the other way around.
      const boardEnvironment = options.environment?.() ?? null
      const own = boardEnvironment === null || boardEnvironment === environment
      return { ...deployment(claims, project, environment, 'all', expiresAt), ...(own ? { own: true as const } : {}) }
    }
    const can = fromSource('vercel', claims)
    if (!can) throw forbidden(`project is not a trusted source: ${project || String(claims.project_id)}`)
    return deployment(claims, project, environment, can, expiresAt)
  }
}

const LOCAL_SUB = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

async function localPerson(token: string, local: NonNullable<AuthOptions['local']>, audience: string): Promise<Principal> {
  let claims: Claims
  try {
    ;({ payload: claims } = (await jwtVerify(token, local.jwks, { issuer: local.issuer, audience })) as { payload: Claims })
  } catch (error) {
    throw unauthorized(`invalid token: ${(error as Error).message}`)
  }
  const sub = String(claims.sub ?? '')
  if (!LOCAL_SUB.test(sub)) throw unauthorized('local token without a valid sub')
  return {
    id: `local:user:${sub}`,
    kind: 'person',
    handle: sub,
    can: 'all',
    expiresAt: claims.exp ? new Date(claims.exp * 1000) : null,
  }
}

const deployment = (
  claims: Claims,
  project: string,
  environment: string,
  can: Principal['can'],
  expiresAt: Date | null,
): Principal => ({
  id: `vercel:project:${String(claims.project_id)}:${environment}`,
  kind: 'deployment',
  handle: environment === 'production' ? project : `${project}@${environment}`,
  can,
  expiresAt,
})

export const allows = (principal: Principal, capability: Capability) =>
  principal.can === 'all' || principal.can.has(capability)
