import { own } from '../contract/own.ts'
import type { ActorsState, Actor } from '../contract/folds.ts'
import { toStorable, type Author } from '../contract/schemas.ts'
import { extractMentions } from '../contract/mentions.ts'
import { parseScope } from './access.ts'
import type { Claims, Principal } from './auth.ts'
import { badRequest } from './errors.ts'

/** Agents whose avatars the board serves itself. */
export const KNOWN_AGENTS = ['claude', 'codex', 'grok', 'pi'] as const

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const HANDLE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
/** An actor ID starts with where it's from: `vercel:user:u_abc123+claude`, `slack:user:U0456`, `board:client`. */
const isActorId = (id: string) => id.length <= 256 && /^[^\s:]+:\S+$/.test(id)

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
  const scope = headers.get('x-board-scope')
  if (scope !== null)
    try {
      parseScope(scope)
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
  }
  return {
    author: { actor: id, principal: principal.id, profile, session: claims.session },
    actor,
  }
}

export function isAvatarUrl(value: string): boolean {
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
 * a host's principal or one of its profiles, which the board records once.
 */
export function actorSeen(seen: Actor, known: ActorsState, host = false) {
  const existing = own(known.byId, seen.id)
  // Platforms don't always send an avatar (GitHub comments via Chat SDK omit it,
  // its webhooks include it): a missing one keeps the avatar the board knows.
  const actor = seen.kind === 'external' && seen.avatar === null ? { ...seen, avatar: existing?.avatar ?? null } : seen
  if (
    existing &&
    existing.kind === actor.kind &&
    existing.handle === actor.handle &&
    existing.name === actor.name &&
    existing.avatar === actor.avatar &&
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
      ...(host ? { host: true as const } : {}),
    },
  }
}

/**
 * Resolves prose mentions to actor IDs. A `@handle` names the one actor the board
 * has seen with it; `@[actor-id]` names one directly. A handle nobody has stays
 * plain text and comes back in `unknown`, so the writer can be told. A handle
 * several actors share, or an `@[actor-id]` the board doesn't know, fails the
 * write. `lenient` is for platform text: no mention fails it, and one that
 * doesn't resolve stays plain text. Without `candidates`, an ambiguous mention
 * doesn't list who it could be: a caller that can't read every channel can't
 * list actors either.
 */
export function resolveMentions(
  text: string,
  known: ActorsState,
  pending?: Actor,
  lenient = false,
  candidates = true,
): { mentions: string[]; unknown: string[] } {
  const resolved: string[] = []
  const unknown: string[] = []
  const add = (id: string) => {
    if (!resolved.includes(id)) resolved.push(id)
  }
  const fail = (error: Error) => {
    if (!lenient) throw error
  }
  for (const token of extractMentions(text)) {
    if (token.kind === 'actor') {
      if ((isActorId(token.actor) && own(known.byId, token.actor)) || pending?.id === token.actor) add(token.actor)
      else fail(badRequest(`unknown actor @[${token.actor}]`, 'unknown_mention'))
      continue
    }
    const ids = new Set(own(known.byHandle, token.handle) ?? [])
    if (pending && pending.handle.toLowerCase() === token.handle) ids.add(pending.id)
    if (ids.size === 1) add([...ids][0]!)
    else if (ids.size === 0) unknown.push(token.handle)
    else if (!candidates) fail(badRequest(`ambiguous mention @${token.handle}: use @[actor-id]`, 'ambiguous_mention'))
    else {
      const options = [...ids]
        .map((id) => `@[${id}] (${own(known.byId, id)?.name ?? pending?.name ?? id})`)
        .join(' or ')
      fail(badRequest(`ambiguous mention @${token.handle}: use ${options}`, 'ambiguous_mention'))
    }
  }
  return { mentions: resolved, unknown: lenient ? [] : unknown }
}
