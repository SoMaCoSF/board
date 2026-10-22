import type { Access } from './access.ts'
import { resolveActor } from './actors.ts'
import {
  createAuthority,
  fromTokens,
  hostPrincipal,
  issuersOf,
  verifiesTokens,
  type AccessFunction,
  type AccessRule,
  type Authenticate,
  type AuthenticateContext,
  type CallerRequest,
  type HostPrincipal,
  type Known,
  type Principal,
  type RuleFunction,
} from './auth.ts'
import type { Identity } from './backend.ts'
import { HttpError, RejectedError, unauthorized } from './errors.ts'
import type { ProjectIdentity } from './identity.ts'

/** Who may use a board, and what they may do: `board()`'s options for it. */
export type PolicyOptions = {
  /**
   * Who a request is: `oidcTokens()` from `vboard/access` by default, which checks its bearer token
   * for the board's URL (pass it `local` for `vb serve`'s, or test issuers). Or a host's own
   * verifier, `(request) => ({ id, kind, handle })`: who the request is in the board's ID scheme,
   * from its credential or its headers (a session cookie). It replaces the built-in one, so no
   * token's audience or the board's own project counts then, unless it calls `oidcTokens()` itself.
   * Null when it recognizes nothing; to reject, return or throw a `Response`.
   */
  authenticate?: Authenticate
  /**
   * Who besides the board's people and its own deployments in the environment it runs in may use
   * it, and what they may do in each channel: `vercelProject()`, `githubActions()`, `oidc()` from
   * `vboard/access`, and functions of your own, `(principal) => can`, for principals your
   * `authenticate` returns. The first rule that matches decides; a function's undefined leaves it to
   * the next. A production board's previews need a rule, as
   * `vercelProject({ project: 'self', environments: ['preview'], can })`.
   *
   * Or a host's own model: one function of the principal its `authenticate` returned, giving what it
   * may do in each channel (`'all'`, `['read']`, `{ 'dev/': ['post'] }`), or null for nothing.
   * Nothing else is trusted then, not the board's own people or deployments.
   *
   * On `http()`, a board with none serves no requests but wake-ups and webhooks; with one, it serves
   * its callers within it, as its project on the board it uses.
   */
  access?: readonly (AccessRule | RuleFunction)[] | AccessFunction
  /**
   * The board's Vercel project: `self` in the rules, whose people's development tokens it takes,
   * and what discovery names for clients to mint them. Defaults to `VERCEL_PROJECT_ID` or
   * `.vercel/project.json`.
   */
  project?: { id: string; teamId?: string }
}

/** What a build of vboard finds in its environment for a board's policy: Node's verifies OIDC tokens and reads the board's Vercel project. */
export type Serving = {
  oidcTokens(): Authenticate
  ownProjectId(configured?: { id: string }): Promise<string | null>
  ownTeamId(configured?: { teamId?: string }): Promise<string | null>
  discoveryIdentity(headers: Headers | null, configured?: { id: string; teamId?: string }): Promise<ProjectIdentity>
}

/** board()'s policy: who each request is, and what principals may do, now and at every send and match. */
export type Policy = ReturnType<typeof createPolicy>

/**
 * The policy a board's options say: verifying requests, and `access` over them and over the
 * principals its backend stores. `keeps`: the backend keeps the board, so the defaults let its
 * people and own deployments in when `access` is left out.
 */
export function createPolicy(options: PolicyOptions, keeps: boolean, serving: (() => Promise<Serving>) | null) {
  /** Whether requests are served at all: a board on `http()` serves none without an `access` of its own. */
  const open = keeps || options.access !== undefined
  const access = options.access ?? []

  /** The board's own Vercel project and team, from `project` or the environment, asked once. */
  let own: Promise<{ id: string | null; teamId: string | null }> | null = null
  const project = () =>
    (own ??= (async () => {
      if (!serving) return { id: options.project?.id ?? null, teamId: options.project?.teamId ?? null }
      const found = await serving()
      const [id, teamId] = await Promise.all([found.ownProjectId(options.project), found.ownTeamId(options.project)])
      return { id, teamId }
    })()).catch((error: unknown) => {
      own = null
      throw error
    })

  /** What discovery says the board's project is, as a request shows it: clients mint tokens with it. */
  async function discoveryIdentity(headers: Headers): Promise<ProjectIdentity> {
    if (!serving) return { projectId: options.project?.id ?? null, teamId: options.project?.teamId ?? null }
    return (await serving()).discoveryIdentity(headers, options.project)
  }

  let tokens: Promise<Authenticate> | null = null
  /** The verifier: `authenticate`, or `oidcTokens()` where this build has it. */
  const verifier = (): Promise<Authenticate> =>
    options.authenticate
      ? Promise.resolve(options.authenticate)
      : (tokens ??= serving
          ? serving().then((found) => found.oidcTokens())
          : Promise.reject(new HttpError(501, 'no_verifier', "this build of vboard verifies no tokens: pass board({ authenticate })")))

  // What callers may do, under this board's rules: requests, and stored principals. A board whose
  // verifier is the built-in one alone takes no host's principals.
  const authority = createAuthority({ access, project, hosts: options.authenticate !== undefined && !verifiesTokens(options.authenticate) })
  const context: AuthenticateContext = { project, issuers: typeof access === 'function' ? [] : issuersOf(access) }
  /** Verified principals by credential, until they expire, so a stream's polls don't verify from scratch. */
  const verified = new Map<string, { principal: Promise<Principal>; until: number }>()
  /** And by request, for one with no credential (a session cookie), for as long as it's served. */
  const perRequest = new WeakMap<CallerRequest, Promise<Principal>>()

  /** Who a request's credential is: a 401 or the host's own rejection when it's no one. */
  async function principalOf(request: CallerRequest): Promise<Principal> {
    const live = (principal: Principal) => principal.expiresAt === null || principal.expiresAt.getTime() > Date.now()
    const known = perRequest.get(request)
    if (known) {
      const principal = await known
      if (live(principal)) return principal
    }
    // What Vercel sends with the request can tell a deployment's token which team the board is on.
    const key = request.credential === null ? null : [request.audience, request.credential, request.headers.get('x-vercel-oidc-token') ?? ''].join('\u001f')
    const cached = key === null ? undefined : verified.get(key)
    if (cached && cached.until > Date.now()) {
      perRequest.set(request, cached.principal)
      return cached.principal
    }
    const principal = verify(request)
    perRequest.set(request, principal)
    if (key !== null)
      principal.then(
        (found) => {
          // A host's principals may lose access any time, so only a token's are kept: until it expires.
          if (found.facts?.issuer === 'host' || found.expiresAt === null) return
          if (verified.size >= 1000) verified.delete(verified.keys().next().value!)
          verified.set(key, { principal, until: found.expiresAt.getTime() })
        },
        () => perRequest.delete(request),
      )
    return principal
  }

  async function verify(request: CallerRequest): Promise<Principal> {
    const authenticate = await verifier()
    let result: Awaited<ReturnType<Authenticate>>
    try {
      result = await authenticate({ ...request, board: context })
    } catch (error) {
      // A thrown `Response` rejects like a returned one.
      if (error instanceof Response) throw new RejectedError(error)
      throw error
    }
    if (result instanceof Response) throw new RejectedError(result)
    // Nothing it recognizes: no token, and no credential of a host's own.
    if (result === null || result === undefined) throw unauthorized('missing bearer token')
    // What the built-in verifier made stands as it is; anything else is a host's, checked.
    return fromTokens(result) ? (result as Principal) : hostPrincipal(result as HostPrincipal)
  }

  return {
    open,
    project,
    discoveryIdentity,
    /**
     * Who a request is, and what it may do now: verified, under the rules, with the profile it
     * claims. Each call works its access out again; its principal is verified once per credential
     * until it expires.
     */
    async identify(request: CallerRequest): Promise<Identity> {
      const found = await principalOf(request)
      const principal = request.claims.scope === null ? found : { ...found, scope: request.claims.scope }
      const { author, actor } = resolveActor(principal, request.claims, request.audience)
      return { principal: { ...principal, access: await authority.grant(principal) }, author, actor }
    },
    /** What a stored principal (a schedule's creator, a watcher's registrant) may do now: null once nothing. */
    accessNow: (principal: Known): Promise<Access | null> => authority.accessNow(principal),
  }
}
