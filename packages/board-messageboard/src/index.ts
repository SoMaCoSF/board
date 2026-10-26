// `@vercel/board-messageboard`: a board kept on api-messageboard (`/v1/messageboard`). board() serves
// the protocol and checks each request; this translates each call to the messageboard API, as the
// token's holder, on one board of one team.
import { HttpError } from '@vercel/board'
import type {
  ActorView,
  Backend,
  BoardEventView,
  Caller,
  ChannelView,
  Me,
  MessageView,
  Protocol,
  ProtocolMethods,
  ThreadSummaryView,
} from '@vercel/board'

export type MessageboardOptions = {
  /** Where the API is: `https://api.vercel.com`, or a local server. */
  url: string
  /** A Vercel token for the team. Every write is its holder's. */
  token: string
  teamId: string
  /** The board to keep it on. Default: the team's default board, made on first use. */
  boardId?: string
}

/** What the API answers, as `@api/messageboard-types` describes it: only the fields read here. */
type MbActor = {
  id: string
  principal: { type: 'user'; userId: string } | { type: 'app'; clientId: string } | { type: 'project'; projectId: string; environment: string }
  profile?: { name: string; avatar?: string }
  session?: string
}
type MbActorView = { id: string; kind: 'person' | 'agent' | 'deployment' | 'app'; handle: string; name?: string; avatar?: string }
type MbMessage = {
  id: string
  threadId: string
  sequence: number
  replyTo?: number
  text: string
  version: number
  createdAt: number
  createdBy: MbActor
  editedAt?: number
  deletedAt?: number
  reactors?: Record<string, string[]>
  labels?: Record<string, string>
}
type MbThread = { id: string; channelId: string; messageCount: number; lastMessage?: { id: string; sequence: number }; labels?: Record<string, string> }
type MbChannel = { id: string; name: string }
type MbChange = {
  type: string
  channelId: string
  actor: MbActor
  createdAt: number
  threadId?: string
  message?: number
  messageId?: string
  emoji?: string
  labels?: Record<string, { from?: string; to?: string }>
  cursor: string
  currentMessage?: MbMessage
}

/** api-messageboard reads at most this many messages a page. */
const PAGE_MAX = 100
/** And holds a long-poll at most this long, in seconds. */
const WAIT_MAX_S = 25

type LabelFilter = readonly [string, readonly string[] | null]

/** A UUIDv7, which every messageboard write takes as its `operationId`. */
function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let now = Date.now()
  for (let i = 5; i >= 0; i--) {
    bytes[i] = now % 256
    now = Math.floor(now / 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const iso = (ms: number) => new Date(ms).toISOString()

/** `msg_<thread uuid>_<sequence>`: what the API names a message by, and so what the board does. */
function messageId(threadId: string, sequence: number): string {
  return `msg_${threadId.slice('thr_'.length)}_${sequence}`
}

function locate(id: string): { threadId: string; sequence: number } {
  const match = /^msg_([0-9a-f-]{36})_([1-9][0-9]*)$/.exec(id)
  if (!match) {
    throw new HttpError(404, 'message_not_found', `message not found: ${id}`)
  }
  return { threadId: `thr_${match[1]}`, sequence: Number(match[2]) }
}

/** The principal behind an actor, without the agent profile it may act as. */
function principalOf(actor: MbActor): string {
  const plus = actor.id.indexOf('+')
  return plus === -1 ? actor.id : actor.id.slice(0, plus)
}

function authorOf(actor: MbActor) {
  return { actor: actor.id, principal: principalOf(actor), profile: actor.profile?.name ?? null, session: actor.session ?? null }
}

function kindOf(kind: MbActorView['kind']): Me['kind'] {
  return kind === 'app' ? 'deployment' : kind
}

/** Who wrote it, from the actor the API recorded: the board knows no more about them here. */
function actorViewOf(actor: MbActor): ActorView {
  let handle = actor.id
  if (actor.principal.type === 'user') {
    handle = actor.principal.userId
  }
  return { kind: actor.profile ? 'agent' : 'person', handle, name: actor.profile?.name ?? handle, avatar: actor.profile?.avatar ?? null }
}

function matchesLabels(filters: readonly LabelFilter[], ...sets: (Record<string, string> | undefined)[]): boolean {
  return filters.every(([key, values]) =>
    sets.some((labels) => {
      const value = labels?.[key]
      if (value === undefined) {
        return false
      }
      return values === null || values.includes(value)
    }),
  )
}

/** A board on api-messageboard. Schedules, files, watchers, and sync aren't kept there yet. */
export function messageboard(options: MessageboardOptions): Backend {
  const base = options.url.replace(/\/+$/, '')

  async function api<T>(method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const params = new URLSearchParams({ teamId: options.teamId })
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) {
        params.set(key, String(value))
      }
    }
    const response = await fetch(`${base}/v1/messageboard${path}?${params}`, {
      method,
      headers: { authorization: `Bearer ${options.token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    }).catch((error: unknown) => {
      throw new HttpError(502, 'unreachable', `api-messageboard didn't answer: ${error instanceof Error ? error.message : String(error)}`)
    })
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (!response.ok) {
      throw new HttpError(response.status, body?.error?.code ?? 'remote_error', body?.error?.message ?? `api-messageboard answered ${response.status}`)
    }
    return body as T
  }

  let board: Promise<string> | null = null
  const boardId = () => {
    if (options.boardId) {
      return Promise.resolve(options.boardId)
    }
    board ??= api<{ board: { id: string } }>('POST', '/boards/default', { body: { operationId: operationId() } }).then((result) => result.board.id)
    board.catch(() => (board = null))
    return board
  }
  const onBoard = async (path: string) => `/boards/${await boardId()}${path}`

  // Channels are named by path on the board and by ID in the API. Neither changes, so both are kept.
  const channelIds = new Map<string, string>()
  const channelPaths = new Map<string, string>()
  const remember = (channel: MbChannel) => {
    channelIds.set(channel.name, channel.id)
    channelPaths.set(channel.id, channel.name)
    return channel.id
  }

  /** The API's channel for a board path, made the first time it's named: on a board, every path is a channel. */
  async function channelId(path: string): Promise<string> {
    const known = channelIds.get(path)
    if (known) {
      return known
    }
    const { channels } = await api<{ channels: MbChannel[] }>('GET', await onBoard('/channels'), { query: { name: path } })
    if (channels[0]) {
      return remember(channels[0])
    }
    const { channel } = await api<{ channel: MbChannel }>('POST', await onBoard('/channels'), { body: { operationId: operationId(), name: path } })
    return remember(channel)
  }

  async function channelPath(id: string): Promise<string> {
    const known = channelPaths.get(id)
    if (known) {
      return known
    }
    remember(await api<MbChannel>('GET', await onBoard(`/channels/${id}`)))
    return channelPaths.get(id)!
  }

  function view(message: MbMessage, channel: string): MessageView {
    const root = messageId(message.threadId, 1)
    const isRoot = message.sequence === 1
    const replyTo = message.replyTo !== undefined && message.replyTo !== 1 ? messageId(message.threadId, message.replyTo) : null
    return {
      id: message.id,
      channel,
      text: message.text,
      re: isRoot ? null : root,
      replyTo,
      thread: message.threadId,
      labels: message.labels ?? {},
      reactions: message.reactors ?? {},
      mentions: [],
      by: authorOf(message.createdBy),
      noSync: false,
      origin: null,
      from: null,
      createdAt: iso(message.createdAt),
      editedAt: message.editedAt === undefined ? null : iso(message.editedAt),
      deleted: message.deletedAt !== undefined,
      undelivered: {},
      attachments: [],
      links: [],
      version: message.version,
      author: actorViewOf(message.createdBy),
    }
  }

  async function threadOf(threadId: string): Promise<MbThread> {
    return (await api<{ thread: MbThread }>('GET', await onBoard(`/threads/${threadId}`))).thread
  }

  /** Root labels by thread, read once per call: a reply matches a label on its root. */
  function rootLabels() {
    const threads = new Map<string, Promise<Record<string, string> | undefined>>()
    return (threadId: string) => {
      let labels = threads.get(threadId)
      if (!labels) {
        labels = threadOf(threadId).then((thread) => thread.labels)
        threads.set(threadId, labels)
      }
      return labels
    }
  }

  /** The filters this board can apply: one channel at a time, by label, thread, or text. */
  function filtersOf(query: { channel?: string; re?: string; by?: string; mentions?: string; from?: string; text?: string }) {
    if (query.channel === undefined) {
      throw new HttpError(400, 'invalid_request', 'this board reads one channel at a time: pass `channel`')
    }
    if (query.by !== undefined || query.mentions !== undefined || (query.from !== undefined && query.from !== 'board')) {
      throw new HttpError(400, 'invalid_request', "this board doesn't filter by `by`, `mentions`, or a sync's `from` yet")
    }
    const thread = query.re === undefined ? undefined : locate(query.re).threadId
    const text = query.text?.toLowerCase()
    return {
      channel: query.channel,
      keeps: (message: MbMessage) => (thread === undefined || message.threadId === thread) && (text === undefined || message.text.toLowerCase().includes(text)),
    }
  }

  async function readThread(threadId: string): Promise<MbMessage[]> {
    const messages: MbMessage[] = []
    let cursor: string | undefined
    do {
      const page = await api<{ messages: MbMessage[]; cursor: string | null }>('GET', await onBoard(`/threads/${threadId}/messages`), { query: { cursor } })
      messages.push(...page.messages)
      cursor = page.cursor ?? undefined
    } while (cursor)
    return messages
  }

  let me: Promise<{ actor: MbActor; view: MbActorView }> | null = null
  const whoami = () => {
    me ??= api<{ actor: MbActor; view: MbActorView }>('GET', '/me')
    me.catch(() => (me = null))
    return me
  }

  const notKept = (code: string, what: string) => async () => {
    throw new HttpError(501, code, `this board keeps no ${what}: api-messageboard doesn't have them yet`)
  }

  /** One event as the board shows it, or null for one it has no counterpart for: a task's. */
  function eventOf(change: MbChange, channel: string): BoardEventView | null {
    if (change.threadId === undefined || change.messageId === undefined || change.message === undefined) {
      return null
    }
    const by = authorOf(change.actor)
    const message = change.currentMessage ? view(change.currentMessage, channel) : undefined
    const common = {
      cursor: change.cursor,
      createdAt: iso(change.createdAt),
      ...(message ? { message } : {}),
      actor: { id: change.actor.id, ...actorViewOf(change.actor) },
    }
    const id = change.messageId
    const thread = change.threadId
    switch (change.type) {
      case 'message.posted':
        return {
          ...common,
          type: 'message.posted',
          payload: {
            channel,
            text: message?.text ?? '',
            re: change.message === 1 ? null : messageId(thread, 1),
            replyTo: message?.replyTo ?? null,
            thread,
            labels: message?.labels ?? {},
            noSync: false,
            mentions: [],
            by,
            origin: null,
            from: null,
            attachments: [],
            links: [],
          },
        } as BoardEventView
      case 'message.edited':
        return { ...common, type: 'message.edited', payload: { id, thread, text: message?.text ?? '', mentions: [], by, from: null } } as BoardEventView
      case 'message.deleted':
        return { ...common, type: 'message.deleted', payload: { id, thread, by, from: null } } as BoardEventView
      case 'message.reaction_added':
      case 'message.reaction_removed':
        return {
          ...common,
          type: change.type === 'message.reaction_added' ? 'reaction.added' : 'reaction.removed',
          payload: { id, thread, emoji: change.emoji ?? '', by, from: null },
        } as BoardEventView
      case 'message.labeled': {
        const set: Record<string, string> = {}
        const unset: string[] = []
        for (const [key, { to }] of Object.entries(change.labels ?? {})) {
          if (to === undefined) {
            unset.push(key)
          } else {
            set[key] = to
          }
        }
        return { ...common, type: 'labels.changed', payload: { id, thread, set, unset, by } } as BoardEventView
      }
      default:
        return null
    }
  }

  const methods: ProtocolMethods = {
    async discovery() {
      return { version: 'messageboard', url: `${base}/v1/messageboard/boards/${await boardId()}`, audience: base, team_id: options.teamId, project_id: null, sync: [] }
    },

    async me() {
      const { actor, view: shown } = await whoami()
      return {
        actor: actor.id,
        principal: principalOf(actor),
        kind: kindOf(shown.kind),
        handle: shown.handle,
        name: shown.name ?? shown.handle,
        avatar: shown.avatar ?? null,
        profile: actor.profile?.name ?? null,
        session: actor.session ?? null,
        expiresAt: null,
        can: { '*': ['read', 'post', 'react', 'label', 'manage'] },
      }
    },

    async channels() {
      const channels: ChannelView[] = []
      let cursor: string | undefined
      do {
        const page = await api<{ channels: MbChannel[]; cursor: string | null }>('GET', await onBoard('/channels'), { query: { cursor } })
        for (const channel of page.channels) {
          remember(channel)
          // The API doesn't count a channel's messages yet.
          channels.push({ path: channel.name, lastIndex: 0, messages: 0, threads: 0 })
        }
        cursor = page.cursor ?? undefined
      } while (cursor)
      return { channels, cursor: 'end' }
    },

    async actors() {
      const actors: Protocol['actors']['output']['actors'] = []
      let cursor: string | undefined
      do {
        const page = await api<{ actors: MbActorView[]; cursor: string | null }>('GET', await onBoard('/actors'), { query: { cursor } })
        for (const actor of page.actors) {
          actors.push({ id: actor.id, kind: kindOf(actor.kind), handle: actor.handle, name: actor.name ?? actor.handle, avatar: actor.avatar ?? null })
        }
        cursor = page.cursor ?? undefined
      } while (cursor)
      return { actors, cursor: 'end' }
    },

    async post(_caller, input) {
      const labels = input.labels && Object.keys(input.labels).length > 0 ? input.labels : undefined
      if (input.channel !== undefined) {
        const { message } = await api<{ message: MbMessage }>('POST', await onBoard('/threads'), {
          body: { operationId: operationId(), channelId: await channelId(input.channel), text: input.text, labels, clientId: input.id },
        })
        return { message: view(message, input.channel) }
      }
      const { threadId, sequence } = locate(input.re!)
      const thread = await threadOf(threadId)
      const { message } = await api<{ message: MbMessage }>('POST', await onBoard(`/threads/${threadId}/messages`), {
        body: { operationId: operationId(), text: input.text, clientId: input.id, ...(sequence === 1 ? {} : { replyTo: sequence }) },
      })
      // A reply takes labels in a second write: the API labels a message once it's posted.
      if (labels) {
        await api('POST', await onBoard(`/threads/${threadId}/messages/${message.sequence}/labels`), { body: { operationId: operationId(), set: labels } })
        message.labels = { ...message.labels, ...labels }
      }
      return { message: view(message, await channelPath(thread.channelId)) }
    },

    async posted(_caller, { id }) {
      const { thread, message } = await api<{ thread: MbThread; message: MbMessage }>('GET', await onBoard(`/posts/${encodeURIComponent(id)}`))
      return { message: view(message, await channelPath(thread.channelId)) }
    },

    async message(_caller, { id }) {
      const { thread } = await api<{ thread: MbThread }>('GET', await onBoard(`/messages/${encodeURIComponent(id)}`))
      const channel = await channelPath(thread.channelId)
      const [root, ...replies] = await readThread(thread.id)
      return { message: view(root!, channel), replies: replies.map((reply) => view(reply, channel)), cursor: `${thread.id}.${thread.messageCount}` }
    },

    async edit(_caller, { id, text }) {
      const { threadId, sequence } = locate(id)
      await api('PATCH', await onBoard(`/threads/${threadId}/messages/${sequence}`), { body: { operationId: operationId(), text } })
      return { ok: true }
    },

    async delete(_caller, { id }) {
      const { threadId, sequence } = locate(id)
      await api('POST', await onBoard(`/threads/${threadId}/messages/${sequence}/delete`), { body: { operationId: operationId() } })
      return { ok: true }
    },

    async react(_caller, { id, emoji, remove }) {
      const { threadId, sequence } = locate(id)
      await api('POST', await onBoard(`/threads/${threadId}/messages/${sequence}/reactions`), { body: { operationId: operationId(), emoji, ...(remove ? { remove } : {}) } })
      return { ok: true }
    },

    async label(_caller, { id, set, unset }) {
      const { threadId, sequence } = locate(id)
      await api('POST', await onBoard(`/threads/${threadId}/messages/${sequence}/labels`), { body: { operationId: operationId(), set, unset } })
      return { ok: true }
    },

    async messages(_caller, query, signal) {
      const { channel, keeps } = filtersOf(query)
      if (query.before !== undefined) {
        throw new HttpError(400, 'invalid_request', "this board doesn't read `before` a message yet")
      }
      const id = await channelId(channel)
      const limit = Math.min(query.limit ?? 50, PAGE_MAX)
      const read = async (after: string | undefined, size: number) =>
        api<{ messages: MbMessage[]; cursor: string }>('GET', await onBoard('/messages'), { query: { channelId: id, after, limit: size }, signal })
      let page: { messages: MbMessage[]; cursor: string }
      // A message ID the API can't resume from: what came after it, among the channel's latest.
      if (query.after?.startsWith('msg_')) {
        const latest = await read(undefined, PAGE_MAX)
        const at = latest.messages.findIndex((message) => message.id === query.after)
        if (at === -1) {
          throw new HttpError(400, 'invalid_request', `after ${query.after}: this board reads after a message only among a channel's latest ${PAGE_MAX}: pass a cursor`)
        }
        page = { messages: latest.messages.slice(at + 1, at + 1 + limit), cursor: latest.cursor }
      } else {
        page = await read(query.after, limit)
      }
      const roots = rootLabels()
      const kept: MessageView[] = []
      for (const message of page.messages) {
        if (!keeps(message)) {
          continue
        }
        if (query.label && !matchesLabels(query.label, message.labels, await roots(message.threadId))) {
          continue
        }
        kept.push(view(message, channel))
      }
      return { messages: kept, cursor: page.cursor }
    },

    async threads(_caller, query) {
      const { channel } = filtersOf(query)
      const id = await channelId(channel)
      // One label goes to the API, which indexes them; any others are checked here.
      const [first, ...rest] = query.label ?? []
      const label = first && first[1]?.length === 1 ? `${first[0]}=${first[1][0]}` : undefined
      const checked = label === undefined ? (query.label ?? []) : rest
      const page = await api<{ threads: MbThread[]; cursor: string | null }>('GET', await onBoard('/threads'), { query: { channelId: id, label, cursor: query.after } })
      const threads: ThreadSummaryView[] = []
      for (const thread of page.threads.slice(0, query.limit ?? PAGE_MAX)) {
        if (!matchesLabels(checked, thread.labels)) {
          continue
        }
        const { message: root } = await api<{ message: MbMessage }>('GET', await onBoard(`/messages/${messageId(thread.id, 1)}`))
        const last = thread.lastMessage && thread.lastMessage.sequence > 1 ? (await api<{ message: MbMessage }>('GET', await onBoard(`/messages/${thread.lastMessage.id}`))).message : null
        threads.push({ message: view(root, channel), replies: thread.messageCount - 1, last: last ? view(last, channel) : null })
      }
      return { threads, cursor: page.cursor ?? 'end' }
    },

    async events(_caller, query, signal) {
      const { channel, keeps } = filtersOf(query)
      if (query.after?.startsWith('msg_')) {
        throw new HttpError(400, 'invalid_request', "this board reads events after a cursor, not a message's ID")
      }
      const id = await channelId(channel)
      const roots = rootLabels()
      const deadline = Date.now() + (query.wait ?? 0) * 1000
      let cursor = query.after
      // Without a cursor, from now on, as on any board. Events this board doesn't show still move the cursor.
      while (true) {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        const page = await api<{ events: MbChange[]; cursor: string }>('GET', await onBoard('/changes'), {
          query: { channelId: id, include: 'message', wait: Math.min(remaining, WAIT_MAX_S), ...(cursor === undefined ? { from: 'latest' } : { cursor }) },
          signal,
        })
        cursor = page.cursor
        const events: BoardEventView[] = []
        for (const change of page.events) {
          const event = eventOf(change, channel)
          const message = change.currentMessage
          if (!event || (message && !keeps(message))) {
            continue
          }
          if (query.label && !matchesLabels(query.label, message?.labels, change.threadId ? await roots(change.threadId) : undefined)) {
            continue
          }
          events.push(event)
        }
        if (events.length > 0 || Date.now() >= deadline || signal.aborted) {
          return { events, cursor }
        }
      }
    },

    async watchers() {
      return { watchers: [] }
    },
    async register() {
      throw new HttpError(403, 'forbidden', "this board keeps no watchers or sync yet: api-messageboard can't register them")
    },
    matches: notKept('no_watchers', 'watchers'),
    ack: notKept('no_watchers', 'watchers'),
    async typing() {
      return { targets: [] }
    },
    async readSource(_caller, { key }) {
      throw new HttpError(404, 'not_synced_here', `this board doesn't run sync entry ${key}`)
    },
    // Nothing syncs from this board yet: a message it can read is synced nowhere, and no link names one.
    async synced(_caller, { id }) {
      await api('GET', await onBoard(`/messages/${encodeURIComponent(id)}`))
      return { targets: [] }
    },
    async linked() {
      throw new HttpError(404, 'message_not_found', "this board syncs nothing yet, so no platform link names one of its messages")
    },

    schedule: notKept('no_scheduler', 'schedules'),
    schedules: notKept('no_scheduler', 'schedules'),
    cancelSchedule: notKept('no_scheduler', 'schedules'),
    upload: notKept('no_files', 'files'),
    attachment: notKept('no_files', 'files'),
    uploadStart: notKept('no_files', 'files'),
    uploadFinish: notKept('no_files', 'files'),
    identity: notKept('no_identity', 'linked accounts'),
    syncImport: notKept('no_sync', 'sync records'),
    syncReceipt: notKept('no_sync', 'sync records'),
    syncThread: notKept('no_sync', 'sync records'),
    syncFind: notKept('no_sync', 'sync records'),
    syncCopies: notKept('no_sync', 'sync records'),
    syncRoots: notKept('no_sync', 'sync records'),
    inboxPush: notKept('no_sync', 'sync inboxes'),
    inboxNext: notKept('no_sync', 'sync inboxes'),
    inboxAck: notKept('no_sync', 'sync inboxes'),
    inbox: notKept('no_sync', 'sync inboxes'),
    syncCode: notKept('no_sync', 'linked accounts'),
    syncAccount: notKept('no_sync', 'linked accounts'),
    syncUnlink: notKept('no_sync', 'linked accounts'),
  }

  // Every call goes to the API as the token's holder, so a caller board() verified, with grants of
  // its own, would get the holder's instead. Until this can pass them on, it serves this deployment's
  // own code only: the handle.
  const ownCodeOnly = Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      async (caller: Caller, input: never, signal: AbortSignal) => {
        if ('identity' in caller) {
          throw new HttpError(403, 'forbidden', "this board serves only this deployment's own code: api-messageboard can't act for another caller yet")
        }
        return (method as (caller: Caller, input: never, signal: AbortSignal) => Promise<unknown>)(caller, input, signal)
      },
    ]),
  ) as unknown as ProtocolMethods

  return {
    ...ownCodeOnly,
    routes: [],
    keeps: false,
    bind(binding) {
      if (Object.keys(binding.subscriptions).length > 0) {
        throw new Error("messageboard: this backend runs no watchers or sync yet: remove board()'s `watch` and `sync`")
      }
    },
  }
}

