import type { ActorsState, Actor } from '../contract/reducers.ts'
import { AGENT_KEY, agentActorId, agentKeyOf, isBoardActor, type Author } from '../contract/schemas.ts'
import { replaceMentions } from '../contract/mentions.ts'
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

/** Who a declared agent is: `board({ agents: { helper: { name: 'Helper' } } })`. */
export type AgentIdentity = {
  /** What people see. Defaults to the key. */
  name?: string
  /** An https URL. The board serves its own for `claude`, `codex`, `grok`, and `pi`. */
  avatar?: string
}

export type DeclaredAgent = { key: string; id: string; name: string; avatar: string | null }
export type DeclaredAgents = ReadonlyMap<string, DeclaredAgent>

/** Checks each agent the board declares, the way watchers are checked: a bad one fails the boot. */
export function declareAgents(config: Record<string, AgentIdentity> | undefined): DeclaredAgents {
  const agents = new Map<string, DeclaredAgent>()
  for (const [key, agent] of Object.entries(config ?? {})) {
    if (!AGENT_KEY.test(key))
      throw new Error(`agents: keys start with a letter, end with a letter or digit, and use up to 32 lowercase letters, numbers, and hyphens, got: ${key}`)
    const name = agent.name === undefined ? key : agent.name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (name.length === 0 || name.length > 128) throw new Error(`agents ${key}: names are 1 to 128 characters`)
    if (agent.avatar !== undefined && !isAvatarUrl(agent.avatar))
      throw new Error(`agents ${key}: avatars must be https URLs (http only on localhost)`)
    agents.set(key, { key, id: agentActorId(key), name, avatar: agent.avatar ?? null })
  }
  return agents
}

/** A declared agent's actor. `url` is the board's, for the avatars it serves itself. */
export function agentActor(agent: DeclaredAgent, url: string | null): Actor {
  const builtIn = url !== null && (KNOWN_AGENTS as readonly string[]).includes(agent.key) ? `${url}/avatars/${agent.key}` : null
  return { id: agent.id, kind: 'agent', handle: agent.key, name: agent.name, avatar: agent.avatar ?? builtIn }
}

/**
 * The actors, with every declared agent in them: an agent is mentionable and listed
 * before it ever writes. Only reads use this; `actorSeen` reads what the log holds,
 * so an agent's first write still records it.
 */
export function withAgents(state: ActorsState, agents: DeclaredAgents, url: string | null): ActorsState {
  if (agents.size === 0) return state
  const byId = { ...state.byId }
  const byHandle = { ...state.byHandle }
  for (const agent of agents.values()) {
    byId[agent.id] ??= agentActor(agent, url)
    const ids = byHandle[agent.key] ?? []
    if (!ids.includes(agent.id)) byHandle[agent.key] = [agent.id, ...ids]
  }
  return { ...state, byId, byHandle }
}

/**
 * The actor a request writes as: its principal, plus the profile it selects. The
 * board's own deployment selecting a declared agent's key writes as that agent;
 * anyone else selecting it gets their own profile of that name.
 */
export function resolveActor(
  principal: Principal,
  headers: Headers,
  boardUrl: string,
  agents: DeclaredAgents = new Map(),
): ResolvedActor {
  const profileName = headers.get('x-board-profile')?.trim() || null
  if (profileName !== null && !PROFILE.test(profileName))
    throw badRequest(
      'profile names start with a letter and use up to 32 letters, numbers, and hyphens',
    )
  const avatarHeader = headers.get('x-board-avatar')?.trim() || null
  if (avatarHeader !== null && !isAvatarUrl(avatarHeader))
    throw badRequest('avatars must be https URLs (http only on localhost)')
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
  const agent = principal.own && profile !== null ? agents.get(profile) : undefined
  if (agent)
    return { author: { actor: agent.id, principal: principal.id, profile, session }, actor: agentActor(agent, boardUrl) }

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

/** An `actor.seen` event, or null when the board already knows these details. */
export function actorSeen(seen: Actor, known: ActorsState) {
  const existing = known.byId[seen.id]
  // Platforms don't always send an avatar (GitHub comments via Chat SDK omit it,
  // its webhooks include it), and an in-process agent can't build the board's own
  // avatar URL: a missing one keeps the avatar the board knows.
  const keeps = (seen.kind === 'external' || agentKeyOf(seen.id) !== null) && seen.avatar === null
  const actor = keeps ? { ...seen, avatar: existing?.avatar ?? null } : seen
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
      handle: actor.handle,
      name: actor.name,
      avatar: actor.avatar,
    },
  }
}

export type MentionContext = {
  /** The actors a write can mention. */
  known: ActorsState
  /** The writer, when the board hasn't seen it yet: it can mention itself. */
  pending?: Actor | undefined
  /** Platform text: a mention that doesn't resolve stays as written, and the rest still count. */
  lenient?: boolean
  /** Who already wrote in the thread: they win a tie between platform users. */
  participants?: ReadonlySet<string>
  /**
   * Platform text: where a typed `@name` is a mention, as an actor ID prefix
   * (`github:user:`), or null when only what the platform marked counts. Board text
   * leaves it out: a typed `@name` there is anyone the board knows.
   */
  scope?: string | null
  /**
   * Whether an ambiguous mention's error lists who it could be. A caller that can't read
   * every channel can't list actors either, so it gets `use @[actor-id]` alone.
   */
  candidates?: boolean
}

/**
 * The order a typed `@handle` resolves in, when several actors share it: a declared
 * agent, then a person, then an agent profile (`julian/claude`), then a deployment or
 * workflow, then a platform user. The board's own watchers, clients, and middleware
 * are never mentioned.
 */
function rank(id: string, actor: Actor | undefined): number | null {
  if (agentKeyOf(id) !== null) return 0
  if (isBoardActor(id)) return null
  switch (actor?.kind) {
    case 'person':
      return 1
    case 'agent':
      return 2
    case 'deployment':
    case 'workflow':
      return 3
    default:
      return 4
  }
}

/**
 * Resolves prose mentions to actors, and rewrites each one it resolves to its exact
 * form, `@[actor-id]`, so what's stored can never be ambiguous. `@[actor-id]` must
 * name an actor the board knows. A handle nobody has stays plain text and comes back
 * in `unknown`, so the writer can be told; one several actors share fails the write.
 * `lenient` is for platform text: no mention fails it, and `unknown` stays empty.
 */
export function resolveMentions(text: string, context: MentionContext): { text: string; mentions: string[]; unknown: string[] } {
  const mentions: string[] = []
  const unknown: string[] = []
  const add = (id: string) => {
    if (!mentions.includes(id)) mentions.push(id)
  }
  const rewritten = replaceMentions(text, (token) => {
    if (token.kind === 'actor') {
      if (actorIn(context, token.actor)) add(token.actor)
      else if (!context.lenient) throw badRequest(`unknown actor @[${token.actor}]`, 'unknown_mention')
      return null
    }
    const id = resolveHandle(token.handle, context)
    if (id === null) {
      if (!context.lenient && !unknown.includes(token.handle)) unknown.push(token.handle)
      return null
    }
    add(id)
    return `@[${id}]`
  })
  return { text: rewritten, mentions, unknown }
}

const actorIn = ({ known, pending }: MentionContext, id: string) => known.byId[id] ?? (pending?.id === id ? pending : undefined)

/**
 * The one actor `@handle` names, in the order `rank` gives. Null when it names none; when it
 * names several, null if lenient, else an error.
 */
export function resolveHandle(handle: string, context: MentionContext): string | null {
  const { known, pending, lenient = false, participants, scope, candidates = true } = context
  if (scope === null) return null
  const ids = new Set(known.byHandle[handle] ?? [])
  if (pending && pending.handle.toLowerCase() === handle) ids.add(pending.id)
  if (scope !== undefined) for (const id of ids) if (!id.startsWith(scope)) ids.delete(id)
  let best: string[] = []
  let bestRank = Infinity
  for (const id of ids) {
    const ranked = rank(id, actorIn(context, id))
    if (ranked === null || ranked > bestRank) continue
    if (ranked < bestRank) {
      best = []
      bestRank = ranked
    }
    best.push(id)
  }
  // Platform accounts linked to one person are that person.
  if (bestRank === 4) best = [...new Set(best.map((id) => (known.byId[known.links[id]?.to ?? ''] ? known.links[id]!.to : id)))]
  if (best.length > 1 && participants) {
    const inThread = best.filter((id) => participants.has(id))
    if (inThread.length === 1) best = inThread
  }
  if (best.length === 1) return best[0]!
  if (lenient || best.length === 0) return null
  if (!candidates) throw badRequest(`ambiguous mention @${handle}: use @[actor-id]`, 'ambiguous_mention')
  const options = best.map((id) => `@[${id}] (${actorIn(context, id)?.name ?? id})`).join(' or ')
  throw badRequest(`ambiguous mention @${handle}: use ${options}`, 'ambiguous_mention')
}
