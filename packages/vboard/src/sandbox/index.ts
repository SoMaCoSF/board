// `vboard/sandbox`: a Vercel Sandbox network policy that lets an agent reach a board as one identity.
import type { NetworkPolicyRule } from '@vercel/sandbox'
import { routes, type RouteName } from '../api/routes.ts'
import { parseScope, type Can, type Grant } from '../server/access.ts'
import { resolveActor } from '../server/actors.ts'
import { escape } from '../server/routing.ts'

/** What `vb` and the client SDK read and write a board with. No other route gets the credentials, a new one included. */
const AGENT_ROUTES = [
  'discovery', 'me', 'channels', 'actors', 'messages', 'threads', 'message', 'posted', 'events', 'attachment', 'schedules',
  'post', 'edit', 'delete', 'react', 'label', 'sync', 'typing', 'upload', 'schedule', 'cancelSchedule',
] as const satisfies readonly RouteName[]

const LITERALS = new Set(Object.values(routes).flatMap(({ path }) => path.split('/').filter((part) => part !== '' && !part.startsWith(':'))))

/**
 * A path parameter as the client encodes it: one segment. Not `\`, `%5C`, or `%2F`, which a URL parser or an edge
 * could read as `/` once the proxy has let the path through. The proxy matches `\` as `%5C`.
 */
const SEGMENT = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[013-46-9A-Fa-f][0-9A-Fa-f]|%2[0-9A-Ea-e]|%5[0-9ABD-Fabd-f])+"

const BLOCKED = JSON.stringify({ error: { code: 'blocked', message: "this sandbox's network policy doesn't let it use this route" } })

export type BoardRulesOptions = {
  /** The board's URL, as the sandbox's `VBOARD_URL` has it: `https://acme.vercel.app/api/board`. */
  url: string
  /** An OIDC token whose audience is the board's URL. The sandbox never sees it. */
  token: string
  /** The profile the sandbox writes as. */
  profile: string
  /** The profile's avatar, an https URL. */
  avatar?: string
  /** The runtime session its writes record. */
  session?: string
  /** Narrows what the token may do there, sent as `x-board-scope`: `{ 'dev/': ['read', 'post'] }`. */
  scope?: Can
  /** More headers for the board's requests, like `x-vercel-protection-bypass`. */
  headers?: Record<string, string>
  /** Credentials only requests that send `authorization: Bearer <placeholder>`, the sandbox's `VBOARD_TOKEN`. */
  placeholder?: string
}

const pattern = (path: string) =>
  path === '/' ? '/?' : path.split('/').filter(Boolean).map((part) => `/${part.startsWith(':') ? SEGMENT : escape(part)}`).join('')

function scopeHeader(scope: Can): string {
  const entries: [string, Grant][] = typeof scope === 'string' || Array.isArray(scope) ? [['*', scope as Grant]] : Object.entries(scope)
  const header = entries.map(([channels, grant]) => `${channels}=${grant === 'all' ? 'all' : grant.join(',')}`).join(';')
  parseScope(header)
  return header
}

/**
 * The board's host, for a network policy's `allow`: its agent routes get the token and a pinned identity on the way
 * out, and every other path under the board, webhooks included, answers 403 from the proxy. Paths outside the
 * board pass as they are.
 */
export function boardRules(options: BoardRulesOptions): Record<string, NetworkPolicyRule[]> {
  const url = new URL(options.url)
  const base = url.pathname.replace(/\/+$/, '')
  // The board matches a route at the end of a request's path, so a route's segment in its own path could send an allowed path elsewhere.
  const clash = base.split('/').find((segment) => LITERALS.has(segment))
  if (clash) throw new Error(`the board's path ${base} has ${clash}, a segment of its routes, so allowed paths could reach other routes: mount it at another path`)
  for (const name of Object.keys(options.headers ?? {}))
    if (/^(authorization|x-board-)/i.test(name)) throw new Error(`headers can't set ${name}: boardRules sets it`)

  const headers = {
    ...options.headers,
    authorization: `Bearer ${options.token}`,
    // Every identity header, so the sandbox can't send its own: an empty one is none.
    'x-board-profile': options.profile,
    'x-board-avatar': options.avatar ?? '',
    'x-board-session': options.session ?? '',
    'x-board-handle': '',
    'x-board-name': '',
    ...(options.scope === undefined ? {} : { 'x-board-scope': scopeHeader(options.scope) }),
  }
  // The board's own checks of the profile and avatar, so a bad one fails here rather than on every request.
  resolveActor({ id: 'sandbox', kind: 'deployment', handle: 'sandbox', expiresAt: null }, new Headers(headers), url.href)

  const placeholder =
    options.placeholder === undefined ? {} : { headers: [{ key: { exact: 'authorization' }, value: { exact: `Bearer ${options.placeholder}` } }] }
  const credentialed = (['GET', 'POST'] as const).map((method): NetworkPolicyRule => {
    const paths = AGENT_ROUTES.filter((name) => routes[name].method === method).map((name) => pattern(routes[name].path))
    return { match: { method: [method], path: { regex: `^${escape(base)}(?:${paths.join('|')})$` }, ...placeholder }, transform: [{ headers }] }
  })
  return {
    [url.hostname]: [
      ...credentialed,
      { match: { path: { regex: `^${escape(base)}(?:/.*)?$` } }, response: { statusCode: 403, contentType: 'application/json', body: BLOCKED } },
    ],
  }
}
