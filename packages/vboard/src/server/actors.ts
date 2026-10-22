import { BlockList, isIP } from 'node:net'
import type { ActorsState, Actor } from '../contract/reducers.ts'
import { toStorable, type Author } from '../contract/schemas.ts'
import { extractMentions } from '../contract/mentions.ts'
import type { Principal } from './auth.ts'
import { badRequest } from './errors.ts'

/** Agents whose avatars the board serves itself. */
export const KNOWN_AGENTS = ['claude', 'codex', 'grok', 'pi'] as const

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const HANDLE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

export type ResolvedActor = {
  author: Author
  actor: Actor
}

/** The actor a request writes as: its principal, plus the profile it selects. */
export function resolveActor(
  principal: Principal,
  headers: Headers,
  boardUrl: string,
): ResolvedActor {
  const profileName = headers.get('x-board-profile')?.trim() || null
  if (profileName !== null && !PROFILE.test(profileName))
    throw badRequest(
      'profile names start with a letter and use up to 32 letters, numbers, and hyphens',
    )
  const avatarHeader = headers.get('x-board-avatar')?.trim() || null
  if (avatarHeader !== null && !isAvatarUrl(avatarHeader, boardUrl))
    throw badRequest('avatars must be https URLs on public hosts (local ones only on a local board)')
  const session = headers.get('x-board-session')?.trim().slice(0, 200) || null

  let baseHandle = principal.handle
  let personName: string | null = null
  if (principal.kind === 'person') {
    const sent = headers.get('x-board-handle')?.trim().toLowerCase()
    if (sent) {
      if (!HANDLE.test(sent)) throw badRequest(`invalid handle: ${sent}`)
      baseHandle = sent
    }
    // A display name, URI-encoded so any language fits in a header.
    const name = headers.get('x-board-name')
    if (name) {
      try {
        personName = decodeURIComponent(name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) || null
      } catch {
        throw badRequest('x-board-name must be URI-encoded')
      }
    }
  }

  const profile = profileName?.toLowerCase() ?? null
  const id = profile === null ? principal.id : `${principal.id}+${profile}`
  const known = profile !== null && (KNOWN_AGENTS as readonly string[]).includes(profile)
  const actor: Actor = {
    id,
    kind: profile === null ? principal.kind : 'agent',
    handle: profile === null ? baseHandle : `${baseHandle}/${profile}`,
    name: profileName ?? personName ?? baseHandle,
    avatar: avatarHeader ?? (known ? `${boardUrl}/avatars/${profile}` : null),
  }
  return {
    author: { actor: id, principal: principal.id, profile, session },
    actor,
  }
}

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

const NETWORK = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const)
  NETWORK.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['fc00::', 7], ['fe80::', 10]] as const) NETWORK.addSubnet(address, prefix, 'ipv6')

/** Where a host is from a reader's browser: its own machine, its network, or the internet. */
function reach(hostname: string): 'loopback' | 'network' | 'public' {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  const ip = isIP(host)
  const family = ip === 6 ? 'ipv6' : 'ipv4'
  if (ip ? LOOPBACK.check(host, family) : host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (ip ? NETWORK.check(host, family) : !host.includes('.') || host.endsWith('.local')) return 'network'
  return 'public'
}

/**
 * Every reader's browser loads an avatar, so one on a reader's own machine or
 * network would make it send requests there. Only a board on loopback, whose
 * readers share its machine, takes local ones.
 */
function isAvatarUrl(value: string, boardUrl: string): boolean {
  try {
    const url = new URL(value)
    if (reach(new URL(boardUrl).hostname) === 'loopback')
      return url.protocol === 'https:' || (url.protocol === 'http:' && reach(url.hostname) === 'loopback')
    return url.protocol === 'https:' && reach(url.hostname) === 'public'
  } catch {
    return false
  }
}

/** An `actor.seen` event, or null when the board already knows these details. */
export function actorSeen(seen: Actor, known: ActorsState) {
  const existing = known.byId[seen.id]
  // Platforms don't always send an avatar (GitHub comments via Chat SDK omit it,
  // its webhooks include it): a missing one keeps the avatar the board knows.
  const actor = seen.kind === 'external' && seen.avatar === null ? { ...seen, avatar: existing?.avatar ?? null } : seen
  if (
    existing &&
    existing.kind === actor.kind &&
    existing.handle === actor.handle &&
    existing.name === actor.name &&
    existing.avatar === actor.avatar
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
      if (known.byId[token.actor] || pending?.id === token.actor) add(token.actor)
      else fail(badRequest(`unknown actor @[${token.actor}]`, 'unknown_mention'))
      continue
    }
    const ids = new Set(known.byHandle[token.handle] ?? [])
    if (pending && pending.handle.toLowerCase() === token.handle) ids.add(pending.id)
    if (ids.size === 1) add([...ids][0]!)
    else if (ids.size === 0) unknown.push(token.handle)
    else if (!candidates) fail(badRequest(`ambiguous mention @${token.handle}: use @[actor-id]`, 'ambiguous_mention'))
    else {
      const options = [...ids]
        .map((id) => `@[${id}] (${known.byId[id]?.name ?? pending?.name ?? id})`)
        .join(' or ')
      fail(badRequest(`ambiguous mention @${token.handle}: use ${options}`, 'ambiguous_mention'))
    }
  }
  return { mentions: resolved, unknown: lenient ? [] : unknown }
}
