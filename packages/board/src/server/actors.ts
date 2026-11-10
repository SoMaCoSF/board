import { own } from '../contract/own.ts'
import type { ActorsState, Actor } from '../contract/folds.ts'
import { toStorable, type Author } from '../contract/schemas.ts'
import type { Via } from '../contract/profiles.ts'
import { parseCan } from './access.ts'
import type { Claims, Principal } from './auth.ts'
import { badRequest } from './errors.ts'

/** Agents whose avatars the board serves itself. */
export const KNOWN_AGENTS = ['fx', 'claude', 'codex', 'grok', 'pi'] as const

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const HANDLE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

export type ResolvedActor = {
  author: Author
  actor: Actor
}

/**
 * What a request's headers say about its caller, checked for shape: a 400 for one that's
 * malformed. None of it is verified; board() works out the actor from it once it knows who the
 * credential is.
 */
export function claimsOf(headers: Headers): Claims {
  const profile = headers.get('x-board-profile')?.trim() || null
  if (profile !== null && !PROFILE.test(profile))
    throw badRequest('profile names start with a letter and use up to 32 letters, numbers, and hyphens')
  const avatar = headers.get('x-board-avatar')?.trim() || null
  if (avatar !== null && !isAvatarUrl(avatar)) throw badRequest('avatars must be https URLs (http only on localhost)')
  const session = headers.get('x-board-session')?.trim().slice(0, 200) || null
  const handle = headers.get('x-board-handle')?.trim().toLowerCase() || null
  if (handle !== null && !HANDLE.test(handle)) throw badRequest(`invalid handle: ${handle}`)
  // A display name, URI-encoded so any language fits in a header.
  const encoded = headers.get('x-board-name')
  let name: string | null = null
  if (encoded) {
    try {
      name = decodeURIComponent(encoded).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) || null
    } catch {
      throw badRequest('x-board-name must be URI-encoded')
    }
  }
  // Set by a proxy that holds the credential (Pi's sandbox); it only narrows.
  // The old name, refused rather than ignored: ignoring it would give a proxy that still sends it the token's whole access.
  if (headers.get('x-board-scope') !== null) throw badRequest('x-board-scope is x-board-can now: send the same value as x-board-can', 'invalid_scope')
  const scope = headers.get('x-board-can')
  if (scope !== null)
    try {
      parseCan(scope)
    } catch (error) {
      throw badRequest((error as Error).message, 'invalid_scope')
    }
  return { profile, avatar, session, handle, name, scope }
}

/**
 * The actor a caller writes as: its principal, plus the profile it claims (`vercel:user:u_123+claude`).
 * A person's name is what they claim, and so is their handle unless a host's verifier named them;
 * anyone else's are their principal's. `audience` is the board's URL, which serves the known
 * agents' avatars.
 */
export function resolveActor(principal: Principal, claims: Claims, audience: string): ResolvedActor {
  // A token says only who a person is, so their CLI sends the handle; a host's verifier already said it.
  const claimsHandle = principal.kind === 'person' && principal.facts?.issuer !== 'host'
  const baseHandle = claimsHandle && claims.handle ? claims.handle : principal.handle
  const personName = principal.kind === 'person' ? claims.name : null
  const profile = claims.profile?.toLowerCase() ?? null
  const id = profile === null ? principal.id : `${principal.id}+${profile}`
  const known = profile !== null && (KNOWN_AGENTS as readonly string[]).includes(profile)
  const actor: Actor = {
    id,
    kind: profile === null ? principal.kind : 'agent',
    handle: profile === null ? baseHandle : `${baseHandle}/${profile}`,
    name: claims.profile ?? personName ?? baseHandle,
    avatar: claims.avatar ?? (known ? `${audience}/avatars/${profile}` : null),
    ...(profile === null ? {} : { via: viaOf({ id: principal.id, handle: baseHandle }) }),
  }
  return {
    author: { actor: id, principal: principal.id, profile, session: claims.session },
    actor,
  }
}

/**
 * Who a profile of `principal` acts through, as the board shows it: a deployment by its project's name
 * and its environment (its handle is `www@preview`), anyone else by their handle.
 */
export function viaOf(principal: { id: string; handle: string }): Via {
  const environment = /^vercel:project:[^:]+:([^:]+)$/.exec(principal.id)?.[1] ?? null
  const suffix = `@${environment}`
  const name = environment !== null && principal.handle.endsWith(suffix) && principal.handle.length > suffix.length ? principal.handle.slice(0, -suffix.length) : principal.handle
  return { name, environment }
}

function isAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
  } catch {
    return false
  }
}

/**
 * An `actor.seen` event, or null when the board already knows these details. `host`: the actor is
 * a host's principal or one of its profiles, which the board records once. `seen.verified`: this
 * write's credential named it as shown, which each write says anew.
 */
export function actorSeen(seen: Actor, known: ActorsState, host = false) {
  const existing = own(known.byId, seen.id)
  // Platforms don't always send an avatar (GitHub comments via Chat SDK omit it,
  // its webhooks include it): a missing one keeps the avatar the board knows. A
  // schedule kept from before profiles said who they act through keeps that too.
  const avatar = seen.kind === 'external' && seen.avatar === null ? { avatar: existing?.avatar ?? null } : {}
  const via = seen.via === undefined && existing?.via ? { via: existing.via } : {}
  const platform = seen.platform === undefined && existing?.platform ? { platform: existing.platform } : {}
  const actor: Actor = { ...seen, ...avatar, ...via, ...platform }
  if (
    existing &&
    existing.kind === actor.kind &&
    existing.handle === actor.handle &&
    existing.name === actor.name &&
    existing.avatar === actor.avatar &&
    existing.via?.name === actor.via?.name &&
    existing.via?.environment === actor.via?.environment &&
    existing.platform === actor.platform &&
    existing.verified === actor.verified &&
    (!host || existing.host)
  )
    return null
  return {
    type: 'actor.seen' as const,
    payload: {
      actor: actor.id,
      kind: actor.kind,
      // A platform's names can hold what the board can't store.
      handle: toStorable(actor.handle),
      name: toStorable(actor.name),
      avatar: actor.avatar,
      ...(actor.via ? { via: { name: toStorable(actor.via.name), environment: actor.via.environment } } : {}),
      ...(actor.platform ? { platform: actor.platform } : {}),
      ...(host ? { host: true as const } : {}),
      ...(actor.verified ? { verified: true as const } : {}),
    },
  }
}
