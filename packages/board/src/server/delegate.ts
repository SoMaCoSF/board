import { isDelegateToken } from '../client/client.ts'
import { compileAccess, parseScope, type AccessSummary } from './access.ts'
import type { Claims } from './auth.ts'
import { badRequest } from './errors.ts'

/**
 * Delegate tokens: short-lived tokens a board signs for whoever its caller hands them to (an agent
 * in a sandbox, a widget). One verifies as the caller's own principal, with the profile, avatar,
 * and session it was minted with, and does at most what its scope says of what that principal may
 * do then. It's always narrowed, so a delegate can't register watchers, import as sync, link
 * accounts, or mint another token.
 */

/** The JWT `typ` delegate tokens carry, so no other token the board's URL issues passes for one. */
export const DELEGATE_TYP = 'board-delegate+jwt'
/** The longest a delegate token lives, in seconds. */
export const DELEGATE_TTL_MAX_S = 2 * 3600
/** What `ttl` is when it's left out. */
export const DELEGATE_TTL_DEFAULT_S = 3600

/** What a delegate token says about who it writes as: labels, but signed, so a request can't change them. */
export type Delegate = {
  profile: string | null
  avatar: string | null
  session: string | null
  /** A person's display name when it writes as them, with no profile. */
  name: string | null
  /** The token's ID. */
  jti: string
}

/** A scope string for an access summary, in `x-board-scope`'s syntax: `*=` when it gives nothing. */
export function scopeOf(summary: AccessSummary): string {
  const entries = Object.entries(summary).map(([pattern, permissions]) => `${pattern}=${permissions.join(',')}`)
  return entries.length > 0 ? entries.join(';') : '*='
}

/** What both scopes allow, as one scope. */
export const intersectScopes = (a: string, b: string): string => scopeOf(compileAccess(parseScope(a)).narrow(parseScope(b)).summary())

/** `feedback/*` is the board's `feedback/`: a channel and its subtree. */
export const normalizeScope = (scope: string) =>
  scope
    .split(';')
    .map((entry) => entry.replace(/^(\s*[^=*]+)\/\*(\s*=)/, '$1/$2'))
    .join(';')

/** Whether `token` is a delegate token this board's URL issued: decoded only, never trusted. */
export function isDelegateFor(token: string, audience: string): boolean {
  if (!isDelegateToken(token)) return false
  try {
    const payload = token.split('.')[1]!
    return (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))) as { iss?: unknown }).iss === audience
  } catch {
    return false
  }
}

/**
 * A delegate's request claims: its profile, avatar, and session are the token's. A request that
 * names another profile or session is refused, so nothing it sends passes for someone else.
 */
export function delegateClaims(delegate: Delegate, claims: Claims): Claims {
  if (claims.profile !== null && claims.profile.toLowerCase() !== delegate.profile?.toLowerCase())
    throw badRequest(`this token writes as ${delegate.profile ?? 'its principal, with no profile'}: drop x-board-profile`, 'delegate_profile')
  if (claims.session !== null && claims.session !== delegate.session)
    throw badRequest(`this token writes from ${delegate.session === null ? 'no session' : `session ${delegate.session}`}: drop x-board-session`, 'delegate_session')
  return { ...claims, profile: delegate.profile, avatar: delegate.avatar, session: delegate.session, handle: null, name: delegate.name }
}
