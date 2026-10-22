import { reducer } from 'experimental-a2'
import { canonicalEmoji } from './emoji.ts'
import { own, setOwn } from './own.ts'
import { actorKind, type ActorKind, type Attachment, type Author, type Labels } from './schemas.ts'
import { boardContract, identityContract, type BoardEvent, type Link, type Origin } from './contract.ts'

// A2 clones state at every read and snapshot boundary, so these folds mutate
// in place: an event costs O(1) instead of a copy of every message. A key a
// caller or platform chose is read with `own` and written with `setOwn`, so a
// handle or a channel named `constructor` is like any other.

export type Message = {
  id: number
  channel: string
  text: string
  re: number | null
  replyTo: number | null
  /** The thread key: the root's event ID. */
  thread: string
  labels: Labels
  reactions: Record<string, string[]>
  mentions: string[]
  by: Author
  noSync: boolean
  /** Where it came from on a platform, if it did. */
  origin: Origin | null
  /** The sync key it came from, or null when written on the board. */
  from: string | null
  createdAt: string
  editedAt: string | null
  deleted: boolean
  /** Sync targets this message didn't reach, with why. A later delivery clears its entry. */
  undelivered: Record<string, string>
  attachments: Attachment[]
  /** Platform messages it links to (Slack permalinks), each with what it said. */
  links: Link[]
  /** Set when a schedule posted it: the schedule's ID and which send this was, from 0. */
  schedule?: { id: number; n: number }
  /**
   * Set when its author couldn't read its channel, as `authorizeOwn` checks: where they can't read,
   * it's theirs to edit and delete only then. Its event's payload says so too.
   */
  blind?: true
  /** The index of the last event that changed it. Folds from before it existed leave it out. */
  version?: number
}

export type MessagesState = {
  byId: Record<string, Message>
  /** Thread root → reply IDs, in log order. */
  replies: Record<string, number[]>
}

export const iso = (date: Date | string): string =>
  typeof date === 'string' ? date : date.toISOString()

export function foldMessages(
  state: MessagesState,
  event: BoardEvent,
): MessagesState {
  // Each change to a message is its newest version, so of two views of it, the later is newer.
  const changed = foldMessage(state, event)
  if (changed) changed.version = event.index
  return state
}

/** Applies `event`, and returns the message it changed: none for an event that changes nothing. */
function foldMessage(state: MessagesState, event: BoardEvent): Message | undefined {
  switch (event.type) {
    case 'message.posted': {
      const { payload } = event
      const message: Message = {
        id: event.index,
        channel: payload.channel,
        text: payload.text,
        re: payload.re,
        replyTo: payload.replyTo,
        thread: payload.thread,
        labels: { ...payload.labels },
        reactions: {},
        mentions: payload.mentions,
        by: payload.by,
        noSync: payload.noSync,
        origin: payload.origin,
        from: payload.from,
        createdAt: iso(event.createdAt),
        editedAt: null,
        deleted: false,
        undelivered: {},
        attachments: payload.attachments ?? [],
        links: payload.links ?? [],
        ...(payload.schedule ? { schedule: { ...payload.schedule } } : {}),
        ...(payload.blind ? { blind: true as const } : {}),
      }
      state.byId[event.index] = message
      if (payload.re !== null) (state.replies[payload.re] ??= []).push(event.index)
      return message
    }
    case 'message.edited': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      message.text = event.payload.text
      message.mentions = event.payload.mentions
      message.editedAt = iso(event.createdAt)
      return message
    }
    case 'message.deleted': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      message.deleted = true
      message.text = ''
      message.reactions = {}
      message.mentions = []
      message.attachments = []
      message.links = []
      return message
    }
    case 'reaction.added': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      // Older events may use Slack's names (`+1`); they group with Chat SDK's (`thumbs_up`).
      const emoji = canonicalEmoji(event.payload.emoji)
      const actors = own(message.reactions, emoji)
      if (actors?.includes(event.payload.by.actor)) return undefined
      if (actors) actors.push(event.payload.by.actor)
      else setOwn(message.reactions, emoji, [event.payload.by.actor])
      return message
    }
    case 'reaction.removed': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      const { by } = event.payload
      const emoji = canonicalEmoji(event.payload.emoji)
      const had = own(message.reactions, emoji)
      if (!had?.includes(by.actor)) return undefined
      const actors = had.filter((a) => a !== by.actor)
      if (actors.length > 0) setOwn(message.reactions, emoji, actors)
      else delete message.reactions[emoji]
      return message
    }
    case 'labels.changed': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      for (const [key, value] of Object.entries(event.payload.set)) setOwn(message.labels, key, value)
      for (const key of event.payload.unset) delete message.labels[key]
      return message
    }
    case 'message.linked': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      message.links = event.payload.links
      return message
    }
    case 'message.sync_failed': {
      const message = state.byId[event.payload.id]
      if (!message) return undefined
      setOwn(message.undelivered, event.payload.target, event.payload.error)
      return message
    }
    case 'message.synced': {
      const message = state.byId[event.payload.id]
      // Most receipts are for a delivery that never failed: nothing to clear.
      if (!message || !Object.hasOwn(message.undelivered, event.payload.target)) return undefined
      delete message.undelivered[event.payload.target]
      return message
    }
    default:
      return undefined
  }
}

export const messagesReducer = reducer({
  contract: boardContract,
  name: 'vboard.messages.v5',
  initialState: { byId: {}, replies: {} } as MessagesState,
}).fold(foldMessages)

/**
 * Each post's event ID → its message: a retried write with the same ID is already on
 * the board, and doesn't go through the middleware again.
 */
export const postedReducer = reducer({
  contract: boardContract,
  name: 'vboard.posted.v1',
  initialState: {} as Record<string, number>,
}).fold((state, event) => {
  if (event.type === 'message.posted') setOwn(state, event.id, event.index)
  return state
})

export type Channel = {
  path: string
  lastIndex: number
  messages: number
  threads: number
}

export type ChannelsState = Record<string, Channel>

export const channelsReducer = reducer({
  contract: boardContract,
  name: 'vboard.channels.v1',
  initialState: {} as ChannelsState,
}).fold((state, event) => {
  if (event.type !== 'message.posted') return state
  const { channel, re } = event.payload
  const entry = own(state, channel) ?? setOwn(state, channel, { path: channel, lastIndex: 0, messages: 0, threads: 0 })
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return state
})

export type Actor = {
  id: string
  kind: ActorKind
  handle: string
  name: string
  avatar: string | null
  /** A host's principal, or one of its profiles: once it's seen as one, it stays one. Views leave it out. */
  host?: true
}

/** A platform actor proved to be a principal (`actor.linked`). */
export type ActorLink = { to: string; method: 'code' | 'consent'; at: string }

export type ActorsState = {
  byId: Record<string, Actor>
  /** Lowercased handle → actor IDs. Handles aren't reserved, so several can share one. */
  byHandle: Record<string, string[]>
  /** Platform actor → the principal it's linked to. Display and filtering only, never permissions. */
  links: Record<string, ActorLink>
}

/** The principal an actor belongs to: its link, its own principal for a profile (`…+claude`), or itself. */
export function personOf(actors: ActorsState, actor: string): string {
  const linked = own(actors.links, actor)?.to
  if (linked) return linked
  const plus = actor.indexOf('+')
  return plus === -1 ? actor : actor.slice(0, plus)
}

/** The platform actors linked to `principal`. */
export const linkedTo = (actors: ActorsState, principal: string): string[] =>
  Object.entries(actors.links).filter(([, link]) => link.to === principal).map(([actor]) => actor)

export function foldActors(state: ActorsState, event: BoardEvent): ActorsState {
  if (event.type === 'actor.linked') {
    setOwn(state.links, event.payload.actor, { to: event.payload.to, method: event.payload.method, at: iso(event.createdAt) })
    return state
  }
  if (event.type === 'actor.unlinked') {
    delete state.links[event.payload.actor]
    return state
  }
  if (event.type !== 'actor.seen') return state
  const { actor, kind, handle, name, avatar, host } = event.payload
  const previous = own(state.byId, actor)
  if (previous) {
    const key = previous.handle.toLowerCase()
    const remaining = (own(state.byHandle, key) ?? []).filter((id) => id !== actor)
    if (remaining.length > 0) setOwn(state.byHandle, key, remaining)
    else delete state.byHandle[key]
  }
  setOwn(state.byId, actor, { id: actor, kind: actorKind(kind), handle, name, avatar, ...(host || previous?.host ? { host: true as const } : {}) })
  const key = handle.toLowerCase()
  const ids = own(state.byHandle, key) ?? setOwn(state.byHandle, key, [])
  if (!ids.includes(actor)) ids.push(actor)
  return state
}

export const actorsReducer = reducer({
  contract: boardContract,
  name: 'vboard.actors.v2',
  initialState: { byId: {}, byHandle: {}, links: {} } as ActorsState,
}).fold(foldActors)

/** A copy of a board message on a platform. */
/** `files`: the platform's IDs for the message's files, or null when it refused them; unset until they're sent. */
/** `asUser`: posted with its author's own token, so editing or deleting it needs that token too. */
/** `by`: the principal of the sync elsewhere that recorded it, whose copy it is to change; none for the board's own sync's. */
export type ExternalCopy = { thread: string; message: string; files?: string[] | null; asUser?: true; by?: string }

export type SyncedThread = {
  root: number
  channel: string
  kinds?: Record<string, 'channel' | 'thread'>
  /** External channels (start a thread there) and threads (joined), in sync order. */
  targets: string[]
  /** Target → the external thread it resolved to. A thread target resolves to itself. */
  external: Record<string, string>
}

export type SyncState = {
  /** Thread key → its sync. */
  threads: Record<string, SyncedThread>
  /** External thread (grouped) → thread key. */
  byExternalThread: Record<string, string>
  /** Board message → target → its copy there. Includes the copy it came from. */
  copies: Record<string, Record<string, ExternalCopy>>
  /** `${external thread}|${platform message ID}` → board message. */
  byExternalMessage: Record<string, number>
}

/** `slack:C0123ABC:1727.1234` is a thread; `slack:C0123ABC` and `github:owner/repo` are channels. */
export const isThreadTarget = (target: string) => target.slice(target.indexOf(':') + 1).includes(':')

export const externalMessageKey = (thread: string, message: string) => `${thread}|${message}`

const addTarget = (thread: SyncedThread, target: string) => {
  if (!thread.targets.includes(target)) thread.targets.push(target)
}

export function foldSync(state: SyncState, event: BoardEvent): SyncState {
  switch (event.type) {
    case 'message.posted': {
      const { payload } = event
      if (payload.re === null)
        setOwn(state.threads, payload.thread, { root: event.index, channel: payload.channel, targets: [], external: {} })
      const origin = payload.origin
      if (!origin) return state
      const thread = own(state.threads, payload.thread)
      if (thread && payload.re === null) {
        addTarget(thread, origin.thread)
        setOwn((thread.kinds ??= {}), origin.thread, 'thread')
        setOwn(thread.external, origin.thread, origin.thread)
        setOwn(state.byExternalThread, origin.thread, payload.thread)
      }
      const precise = origin.subthread ?? origin.thread
      setOwn((state.copies[event.index] ??= {}), origin.thread, { thread: precise, message: origin.message, ...(payload.importedBy ? { by: payload.importedBy } : {}) })
      state.byExternalMessage[externalMessageKey(precise, origin.message)] = event.index
      return state
    }
    case 'thread.synced': {
      const thread = own(state.threads, event.payload.thread)
      if (!thread) return state
      addTarget(thread, event.payload.target)
      if (event.payload.kind) setOwn((thread.kinds ??= {}), event.payload.target, event.payload.kind)
      if ((event.payload.kind ?? (isThreadTarget(event.payload.target) ? 'thread' : 'channel')) === 'thread') {
        setOwn(thread.external, event.payload.target, event.payload.target)
        setOwn(state.byExternalThread, event.payload.target, event.payload.thread)
      }
      return state
    }
    case 'message.files_synced': {
      // Only the sync whose copy it is says what its files are there.
      const copies = state.copies[event.payload.id]
      const copy = copies && own(copies, event.payload.target)
      if (copy && copy.by === event.payload.syncedBy) copy.files = event.payload.files
      return state
    }
    case 'message.synced': {
      const { id, target, external, syncedBy } = event.payload
      setOwn((state.copies[id] ??= {}), target, { ...external, ...(syncedBy ? { by: syncedBy } : {}) })
      state.byExternalMessage[externalMessageKey(external.thread, external.message)] = id
      const thread = own(state.threads, event.payload.thread)
      if (thread && thread.root === id && ((thread.kinds && own(thread.kinds, target)) ?? (isThreadTarget(target) ? 'thread' : 'channel')) === 'channel') {
        setOwn(thread.external, target, external.thread)
        setOwn(state.byExternalThread, external.thread, event.payload.thread)
      }
      return state
    }
    default:
      return state
  }
}

export type IdentityCode = { principal: string; sync: string; expiresAt: string; usedBy: string | null; usedIn: string | null }
/** Code hash → its code. */
export type IdentityCodesState = Record<string, IdentityCode>

export const identityCodesReducer = reducer({
  contract: identityContract,
  name: 'vboard.identity-codes.v1',
  initialState: {} as IdentityCodesState,
}).fold((state, event) => {
  if (event.type === 'identity.code_issued') {
    const { hash, principal, sync, expiresAt } = event.payload
    state[hash] ??= { principal, sync, expiresAt, usedBy: null, usedIn: null }
  } else if (event.type === 'identity.code_used') {
    const code = state[event.payload.hash]
    if (code && code.usedBy === null) {
      code.usedBy = event.payload.actor
      code.usedIn = event.payload.message ?? null
    }
  }
  return state
})
