// An in-memory `/v1/messageboard`, as Vercel's API behaves: what
// `vercel()` from `@vercel/board/backend-vercel` is tested against. A bearer token names its principal:
// `user:u_jb`, `app:oac_1`, or `project:prj_pong:production`.
import { randomUUID } from 'node:crypto'

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
  /** A platform user whose write a sync imported. */
  | { type: 'external'; id: string; syncKey: string }
type Actor = { id: string; principal: Principal; profile?: { name: string; avatar?: string }; session?: string }
type Message = {
  id: string
  threadId: string
  sequence: number
  replyTo?: number
  text: string
  revision: number
  createdAt: number
  createdBy: Actor
  editedAt?: number
  deletedAt?: number
  changes: number
  reactions: Map<string, Map<string, { actor: Actor; createdAt: number }>>
  labels: Record<string, string>
  /** Its post's place in its channel's feed, which a channel cursor counts. */
  feedSequence: number
  attachments?: { id: string; name: string; type: string; size: number }[]
  schedule?: { id: string; n: number }
  /** A sync's import: the key it came through, and where on its platform. */
  from?: string
  origin?: Record<string, unknown> & { thread: string; message: string }
  noSync?: boolean
}
type Schedule = {
  id: string
  channelId: string
  threadId?: string
  text: string
  labels?: Record<string, string>
  firstAt: number
  every?: number
  until?: number
  times?: number
  sent: number
  nextAt: number | null
  lastMessageId?: string
  state: 'pending' | 'done' | 'canceled'
  canceled?: { by?: Actor; at: number; reason: 'canceled' | 'revoked' | 'disabled' }
  createdAt: number
  createdBy: Actor
  revision: number
}
type Attachment = { id: string; boardId: string; name: string; type: string; size: number; sha256: string; state: 'pending' | 'ready'; messageId?: string; createdAt: number; createdBy: Actor }
type Thread = {
  id: string
  channelId: string
  messageCount: number
  lastActivityAt: number
  lastMessage?: { id: string; sequence: number; createdAt: number; createdBy: Actor }
  createdAt: number
  createdBy: Actor
  messages: Message[]
}
type Change = Record<string, unknown> & { createdAt: number; messageId?: string }
type ActorView = { id: string; kind: 'person' | 'agent' | 'deployment' | 'app' | 'external'; handle: string; name?: string; lastSeenAt: number }
type Copy = { thread: string; message: string; files?: string[] | null; asUser?: true }
type InboxEntry = { id: string; thread: string; event: unknown; raw: unknown; createdAt: number; lease?: string; leaseUntil?: number; attempts: number; done: boolean }

const EMOJI = /^[a-z0-9_+-]{1,64}$/
const CHANNEL = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/
const MESSAGE_ID = /^msg_([0-9a-f-]{36})_(\d+)$/

class Refused extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Vercel accounts the fake knows, by user ID: how the API names a person (their username, then their name). */
const ACCOUNTS: Record<string, { username: string; name: string }> = {
  u_jb: { username: 'julian', name: 'Julián Benegas' },
  u_ada: { username: 'ada', name: 'Ada Lovelace' },
}

export function fakeMessageboard(options: { teamId?: string; slug?: string; boardId?: string | null; accounts?: Record<string, { username: string; name: string }> } = {}) {
  const accounts = options.accounts ?? ACCOUNTS
  const teamId = options.teamId ?? 'team_test'
  const slug = options.slug ?? 'test'
  let boardId = options.boardId === undefined ? 'brd_test' : options.boardId
  const channels: { id: string; name: string }[] = [{ id: 'general', name: 'general' }]
  const threads = new Map<string, Thread>()
  const posts = new Map<string, string>()
  const feeds = new Map<string, Change[]>()
  const actors = new Map<string, ActorView>()
  const requests: string[] = []
  const attachments = new Map<string, Attachment>()
  /** The bucket: bytes by attachment ID, as presigned PUTs leave them. */
  const stored = new Map<string, Uint8Array<ArrayBuffer>>()
  const STORAGE = 'http://storage.test/'
  type Filter = { channelIds?: string[]; channelTree?: string; threadId?: string; authors?: string[]; text?: string; labels?: { key: string; values?: string[] }[] }
  type Registration = { owner: string; url: string | null; path?: string; branch?: string; watch: Record<string, { filter: Filter; when: 'matches' | 'enters' }>; sync: { key: string; platform: string }[]; hash: string }
  type Match = { id: string; watcher: string; threadId: string; change: Change; lease?: string; leaseUntil?: number; attempts: number }
  /** By principal, as the API keeps them: one each. */
  const registrations = new Map<string, Registration>()
  const queued = new Map<string, Match[]>()
  const schedules = new Map<string, Schedule>()
  // Sync's records, as `messageboard-sync` keeps them: who owns each key, which board thread a
  // platform thread is, which board message a platform message is, an import's client IDs, each
  // thread's targets, and each message's copies on them.
  const keyOwners = new Map<string, string>()
  const externalViews = new Map<string, Omit<ActorView, 'lastSeenAt'>>()
  const platformThreads = new Map<string, string>()
  const platformMessages = new Map<string, string>()
  const imports = new Map<string, string>()
  const syncs = new Map<string, { targets: string[]; external: Record<string, string> }>()
  const copies = new Map<string, Record<string, Copy>>()
  const undelivered = new Map<string, Record<string, string>>()
  const inboxes = new Map<string, InboxEntry[]>()
  let clock = 0
  const now = () => (clock = Math.max(Date.now(), clock + 1))

  const principalId = (p: Principal) =>
    p.type === 'user' ? `vercel:user:${p.userId}` : p.type === 'app' ? `vercel:app:${p.clientId}` : p.type === 'external' ? p.id : `vercel:project:${p.projectId}:${p.environment}`
  const samePrincipal = (a: Principal, b: Principal) => principalId(a) === principalId(b)

  function actorOf(request: Request): Actor {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const [type, id, environment] = token.split(':')
    const principal: Principal | null =
      type === 'user' && id ? { type, userId: id } : type === 'app' && id ? { type, clientId: id } : type === 'project' && id && environment ? { type, projectId: id, environment } : null
    if (!principal) throw new Refused(401, 'unauthorized')
    const name = request.headers.get('x-board-profile') ?? undefined
    const avatar = request.headers.get('x-board-avatar') ?? undefined
    const session = request.headers.get('x-board-session') ?? undefined
    const base = principalId(principal)
    return {
      id: name ? `${base}+${name.toLowerCase()}` : base,
      principal,
      ...(name ? { profile: { name, ...(avatar ? { avatar } : {}) } } : {}),
      ...(session ? { session } : {}),
    }
  }

  /** An actor as the API names them (`viewFor` in api-messageboard): a person by their account. */
  function viewOf(actor: Actor): Omit<ActorView, 'lastSeenAt'> {
    const p = actor.principal
    if (p.type === 'external') return externalViews.get(actor.id) ?? { id: actor.id, kind: 'external', handle: actor.id }
    const account = p.type === 'user' ? accounts[p.userId] : undefined
    const base = p.type === 'user' ? (account?.username ?? p.userId) : p.type === 'app' ? p.clientId : `project:${p.projectId}:${p.environment}`
    if (actor.profile) return { id: actor.id, kind: 'agent', handle: `${base}/${actor.profile.name.toLowerCase()}`, name: actor.profile.name }
    if (p.type === 'user') return { id: actor.id, kind: 'person', handle: base, ...(account ? { name: account.name } : {}) }
    return { id: actor.id, kind: p.type === 'app' ? 'app' : 'deployment', handle: base }
  }
  const seen = (actor: Actor) => actors.set(actor.id, { ...viewOf(actor), lastSeenAt: now() })

  /** A channel's feed position, as the API's `c1.` cursor carries it: shared by its messages and its events. */
  const cursorAt = (channelId: string, position: number) => `c1.${position}.${channelId}`
  function positionOf(channelId: string, cursor: string): number {
    const found = /^c1\.(\d+)\.(.+)$/.exec(cursor)
    if (!found) throw new Refused(400, 'invalid_cursor')
    if (found[2] !== channelId) throw new Refused(400, 'invalid_cursor', 'Cursor belongs to another channel.')
    const position = Number(found[1])
    if (position > (feeds.get(channelId)?.length ?? 0)) throw new Refused(400, 'invalid_cursor', 'Cursor is ahead of this channel.')
    return position
  }

  const show = (m: Message) => ({
    id: m.id,
    threadId: m.threadId,
    sequence: m.sequence,
    ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
    text: m.text,
    revision: m.revision,
    version: 1 + m.changes,
    createdAt: m.createdAt,
    createdBy: m.createdBy,
    ...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
    ...(m.deletedAt !== undefined ? { deletedAt: m.deletedAt } : {}),
    ...(m.reactions.size ? { reactions: Object.fromEntries([...m.reactions].map(([emoji, by]) => [emoji, by.size])) } : {}),
    // Up to 20 reactors an emoji, earliest first: the count is exact.
    ...(m.reactions.size ? { reactors: Object.fromEntries([...m.reactions].map(([emoji, by]) => [emoji, [...by.keys()].slice(0, 20)])) } : {}),
    ...(Object.keys(m.labels).length ? { labels: { ...m.labels } } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.schedule ? { schedule: m.schedule } : {}),
    ...(m.from !== undefined ? { from: m.from } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.noSync ? { noSync: true } : {}),
  })
  const showThread = (t: Thread) => {
    const { messages, ...rest } = t
    const labels = messages[0]?.labels ?? {}
    return { ...rest, teamId, boardId, ...(Object.keys(labels).length ? { labels: { ...labels } } : {}) }
  }
  const meta = (m: Message) => {
    const { id, threadId, sequence, version, reactions, reactors, labels } = show(m)
    return { id, threadId, sequence, version, ...(reactions ? { reactions, reactors } : {}), ...(labels ? { labels } : {}) }
  }

  function emit(channelId: string, change: Record<string, unknown>, actor: Actor) {
    const feed = feeds.get(channelId) ?? []
    feeds.set(channelId, feed)
    const made = { id: `evt_${randomUUID()}`, channelId, actor, createdAt: now(), shard: 0, sequence: feed.length + 1, ...change } as Change
    feed.push(made)
    seen(actor)
    match(made)
    return feed.length
  }

  /** What subscriber-messageboard-changes does with each event: matched against every watcher on the board. */
  function match(change: Change) {
    const messageId = (change as { messageId?: string }).messageId
    const message = messageId ? messageNamed(messageId) : undefined
    if (!message) return
    // A sync gets every message change, and a thread bound to one of its own keys' targets.
    const binding = (change as { binding?: { target: string } }).binding
    for (const registration of registrations.values()) {
      if (registration.sync.length === 0) continue
      if (change.type === 'thread.synced' && !registration.sync.some(({ key }) => binding?.target.startsWith(`${key}:`))) continue
      if (change.type !== 'thread.synced' && !String(change.type).startsWith('message.')) continue
      const lane = queued.get(registration.owner) ?? []
      queued.set(registration.owner, lane)
      lane.push({ id: `mat_${randomUUID()}`, watcher: '@sync', threadId: message.threadId, change, attempts: 0 })
    }
    if (!String(change.type).startsWith('message.')) return
    const thread = threads.get(message.threadId)!
    const channel = channels.find((c) => c.id === thread.channelId)!
    const rootLabels = thread.messages[0]?.labels ?? {}
    const hasLabel = (labels: Record<string, string>, { key, values }: { key: string; values?: string[] }) =>
      Object.hasOwn(labels, key) && (values === undefined || values.includes(labels[key]!))
    const sees = (filter: Filter) =>
      (filter.channelIds === undefined && filter.channelTree === undefined ? true : (filter.channelIds?.includes(channel.id) ?? false) ||
        (filter.channelTree !== undefined && (channel.name === filter.channelTree || channel.name.startsWith(`${filter.channelTree}/`)))) &&
      (filter.threadId === undefined || filter.threadId === message.threadId) &&
      (filter.authors === undefined || filter.authors.includes(message.createdBy.id) || filter.authors.includes(principalId(message.createdBy.principal))) &&
      (filter.text === undefined || message.text.toLowerCase().includes(filter.text.toLowerCase())) &&
      (filter.labels ?? []).every((label) => hasLabel(message.labels, label) || hasLabel(rootLabels, label))
    for (const registration of registrations.values())
      for (const [watcher, spec] of Object.entries(registration.watch)) {
        if ((change.actor as Actor).id === `${registration.owner}+${watcher.toLowerCase()}` || !sees(spec.filter)) continue
        const lane = queued.get(registration.owner) ?? []
        queued.set(registration.owner, lane)
        lane.push({ id: `mat_${randomUUID()}`, watcher, threadId: message.threadId, change, attempts: 0 })
      }
  }

  const messageNamed = (id: string) => {
    const found = MESSAGE_ID.exec(id)
    return found ? threads.get(`thr_${found[1]}`)?.messages[Number(found[2]) - 1] : undefined
  }

  const threadAt = (id: string) => {
    const thread = threads.get(id)
    if (!thread) throw new Refused(404, 'thread_not_found')
    return thread
  }
  const messageAt = (threadId: string, sequence: number) => {
    const message = threadAt(threadId).messages[sequence - 1]
    if (!message) throw new Refused(404, 'message_not_found')
    return message
  }
  const channelAt = (id: string) => {
    const channel = channels.find((c) => c.id === id)
    if (!channel) throw new Refused(404, 'channel_not_found')
    return channel
  }

  function post(
    actor: Actor,
    thread: Thread,
    body: { text: string; replyTo?: number; clientId?: string; labels?: Record<string, string>; attachments?: string[]; schedule?: { id: string; n: number }; after?: number },
    imported?: { from?: string; origin?: Message['origin']; noSync?: boolean },
  ) {
    // A reply's precondition, checked with the post: the thread's newest is still the one it names.
    if (body.after !== undefined && (!Number.isInteger(body.after) || body.after < 1 || body.after > thread.messageCount)) throw new Refused(400, 'invalid_after')
    if (body.after !== undefined && body.after !== thread.messageCount) throw new Refused(409, 'newer_message', `message ${thread.messageCount} came after ${body.after}`)
    const files = (body.attachments ?? []).map((id) => {
      const attachment = attachments.get(id)
      if (!attachment || !samePrincipal(attachment.createdBy.principal, actor.principal)) throw new Refused(404, 'attachment_not_found')
      if (attachment.state !== 'ready') throw new Refused(409, 'attachment_not_ready')
      if (attachment.messageId) throw new Refused(409, 'attachment_already_posted')
      return attachment
    })
    // A post with attachments may have no text.
    if (typeof body.text !== 'string' || (!body.text.trim() && !(files.length && body.text === '')) || body.text.length > 10_000) throw new Refused(400, 'invalid_message')
    if (body.replyTo !== undefined && (body.replyTo < 1 || body.replyTo > thread.messageCount)) throw new Refused(400, 'invalid_reply')
    const sequence = thread.messageCount + 1
    const createdAt = now()
    const message: Message = {
      id: `msg_${thread.id.slice('thr_'.length)}_${sequence}`,
      threadId: thread.id,
      sequence,
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
      text: body.text,
      revision: 1,
      createdAt,
      createdBy: actor,
      changes: 0,
      reactions: new Map(),
      // A post's labels commit with it, so its event's message already has them.
      labels: { ...body.labels },
      feedSequence: 0,
      ...(files.length ? { attachments: files.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
      ...(body.schedule ? { schedule: body.schedule } : {}),
      ...(imported?.from !== undefined ? { from: imported.from } : {}),
      ...(imported?.origin ? { origin: imported.origin } : {}),
      ...(imported?.noSync ? { noSync: true } : {}),
    }
    for (const file of files) file.messageId = message.id
    thread.messages.push(message)
    thread.messageCount = sequence
    thread.lastActivityAt = createdAt
    thread.lastMessage = { id: message.id, sequence, createdAt, createdBy: actor }
    if (body.clientId) posts.set(`${principalId(actor.principal)}|${body.clientId}`, message.id)
    message.feedSequence = emit(thread.channelId, { type: 'message.posted', threadId: thread.id, message: sequence, messageId: message.id, revision: 1, ...(imported?.from !== undefined ? { from: imported.from } : {}) }, actor)
    return message
  }

  /** A repeat of a post with the same client ID, by the same principal: the first one. */
  function repeat(actor: Actor, clientId: unknown) {
    if (clientId === undefined) return null
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)) throw new Refused(400, 'invalid_client_id')
    const id = posts.get(`${principalId(actor.principal)}|${clientId}`)
    if (!id) return null
    const [, uuid, sequence] = MESSAGE_ID.exec(id)!
    const thread = threadAt(`thr_${uuid}`)
    return { thread: showThread(thread), message: show(thread.messages[Number(sequence) - 1]!) }
  }

  function page<T>(items: T[], cursor: string | null, size: number) {
    const from = cursor ? Number(cursor) : 0
    const next = from + size < items.length ? String(from + size) : null
    return { items: items.slice(from, from + size), cursor: next }
  }

  async function watchers(method: string, rest: string, actor: Actor, parsed: Record<string, any>, url: URL): Promise<unknown> {
    const owner = principalId(actor.principal)
    const view = (r: Registration) => ({ owner: r.owner, url: r.url, ...(r.path ? { path: r.path, ...(r.branch ? { branch: r.branch } : {}) } : {}), watch: r.watch, sync: r.sync.map(({ key, platform }) => ({ key, platform, signIn: false })), hash: r.hash })
    if (method === 'GET' && rest === '/watchers') {
      const found = registrations.get(owner)
      return { watchers: found ? [view(found)] : [] }
    }
    if (method === 'PUT' && rest === '/watchers') {
      const body = parsed as { url?: string | null; path?: string; branch?: string; watch: Registration['watch']; sync?: { key: string; platform: string }[]; tag?: string }
      // A URL, or a path on the caller's own project (a preview's with its branch), as api-messageboard checks one.
      if (body.url !== undefined && body.path !== undefined) throw new Refused(400, 'bad_request', 'A url or a path, not both.')
      if (body.branch !== undefined && body.path === undefined) throw new Refused(400, 'bad_request', 'A branch goes with a path.')
      const principal = actor.principal
      if (body.path !== undefined) {
        if (principal.type !== 'project') throw new Refused(403, 'not_a_project')
        if (principal.environment !== 'production' && principal.environment !== 'preview') throw new Refused(400, 'invalid_environment')
        if ((principal.environment === 'preview') !== (body.branch !== undefined)) throw new Refused(400, 'invalid_branch')
        if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.startsWith('//')) throw new Refused(400, 'invalid_path')
      }
      for (const [id, spec] of Object.entries(body.watch))
        if (spec.when === 'enters' && Object.keys(spec.filter).length === 0) throw new Refused(400, 'bad_watcher', `watch ${id}: \`when: enters\` needs a filter to enter`)
      // Sync entries claim their keys: only a project's own token holds any, and a key is one project's.
      const sync = body.sync ?? []
      if (sync.length > 0 && principal.type !== 'project') throw new Refused(403, 'sync_needs_project', "Only a project the board grants syncs: register sync entries with the project's own token.")
      if (new Set(sync.map(({ key }) => key)).size !== sync.length) throw new Refused(400, 'duplicate_sync_key')
      for (const { key } of sync) if ((keyOwners.get(key) ?? owner) !== owner) throw new Refused(409, 'sync_key_taken', `Sync key ${key} is another project's on this board.`)
      for (const [key, holder] of keyOwners) if (holder === owner && !sync.some((entry) => entry.key === key)) keyOwners.delete(key)
      for (const { key } of sync) keyOwners.set(key, owner)
      const where = body.path !== undefined ? { url: null, path: body.path.replace(/(.)\/+$/, '$1'), ...(body.branch ? { branch: body.branch } : {}) } : { url: body.url ?? null }
      const made: Registration = { owner, ...where, watch: body.watch, sync: sync.map(({ key, platform }) => ({ key, platform })), hash: body.tag ?? randomUUID().replaceAll('-', '') }
      registrations.set(owner, made)
      return view(made)
    }
    if (!registrations.has(owner)) throw new Refused(404, 'no_registration')
    const lane = queued.get(owner) ?? []
    if (method === 'GET' && rest === '/watchers/matches') {
      const until = Date.now() + Number(url.searchParams.get('wait') ?? 0) * 1000
      const limit = Number(url.searchParams.get('limit') ?? 10)
      for (;;) {
        const held = new Set(lane.filter((m) => m.lease && m.leaseUntil! > Date.now()).map((m) => `${m.watcher}|${m.threadId}`))
        const heads = new Map<string, Match>()
        for (const m of lane) if (!heads.has(`${m.watcher}|${m.threadId}`)) heads.set(`${m.watcher}|${m.threadId}`, m)
        const free = [...heads.entries()].filter(([key]) => !held.has(key)).map(([, m]) => m).slice(0, limit)
        if (free.length > 0 || Date.now() >= until) {
          for (const m of free) {
            if (m.lease) m.attempts++
            m.lease = randomUUID()
            m.leaseUntil = Date.now() + 5 * 60_000
          }
          const shown = free.map((m) => {
            const message = messageNamed((m.change as { messageId: string }).messageId)
            return { id: m.id, watcher: m.watcher, threadId: m.threadId, lease: m.lease, attempt: m.attempts, event: { ...m.change, ...(message ? { currentMessage: show(message) } : {}) } }
          })
          return { matches: shown }
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const acking = /^\/watchers\/matches\/([^/]+)\/ack$/.exec(rest)
    if (method === 'POST' && acking) {
      const body = parsed as { lease: string; error?: string; skip?: boolean }
      const at = lane.findIndex((m) => m.id === decodeURIComponent(acking[1]!))
      if (at === -1) throw new Refused(404, 'no_match')
      if (lane[at]!.lease !== body.lease) throw new Refused(409, 'stale_lease')
      if (body.error !== undefined && !body.skip) {
        lane[at]!.attempts++
        delete lane[at]!.lease
      } else lane.splice(at, 1)
      return { ok: true }
    }
    throw new Refused(404, 'not_found')
  }

  const showSchedule = (s: Schedule) => ({ ...s, ...(s.labels ? { labels: { ...s.labels } } : {}) })

  /** Times are whole milliseconds, a year out at most, and a repeat is at least a minute apart, with one stop. */
  function schedule(actor: Actor, body: Record<string, any>): Schedule {
    const invalid = () => new Refused(400, 'invalid_schedule')
    if (actor.principal.type === 'app') throw new Refused(403, 'principal_cannot_schedule')
    if ((body.channelId === undefined) === (body.threadId === undefined)) throw invalid()
    if (body.labels !== undefined && body.threadId !== undefined) throw invalid()
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) throw new Refused(400, 'invalid_message')
    const at = Date.now()
    const time = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= at + 365 * 86_400_000
    if (!time(body.firstAt) || body.firstAt < at - 60_000) throw invalid()
    if (body.every !== undefined && (!Number.isInteger(body.every) || body.every < 60_000)) throw invalid()
    if (body.until !== undefined && !time(body.until)) throw invalid()
    if (body.times !== undefined && (!Number.isInteger(body.times) || body.times < 1)) throw invalid()
    const stops = [body.until, body.times].filter((stop) => stop !== undefined).length
    if (stops > 1 || (stops > 0 && body.every === undefined)) throw invalid()
    const channelId = body.threadId !== undefined ? threadAt(body.threadId).channelId : channelAt(body.channelId).id
    const made: Schedule = {
      id: `sch_${randomUUID()}`,
      channelId,
      ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
      text: body.text,
      ...(body.labels ? { labels: { ...body.labels } } : {}),
      firstAt: body.firstAt,
      ...(body.every !== undefined ? { every: body.every } : {}),
      ...(body.until !== undefined ? { until: body.until } : {}),
      ...(body.times !== undefined ? { times: body.times } : {}),
      sent: 0,
      nextAt: Math.max(body.firstAt, at),
      state: 'pending',
      createdAt: now(),
      createdBy: actor,
      revision: 1,
    }
    schedules.set(made.id, made)
    seen(actor)
    return made
  }

  /** A schedule's next send, as the API posts it when it's due: as its creator, marked as the schedule's. */
  function send(id: string) {
    const due = schedules.get(id)
    if (!due || due.state !== 'pending') throw new Error(`schedule ${id} has nothing due`)
    const n = due.sent
    const body = { text: due.text, schedule: { id, n } }
    let message: Message
    if (due.threadId !== undefined) message = post(due.createdBy, threadAt(due.threadId), body)
    else {
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: due.channelId, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: due.createdBy, messages: [] }
      threads.set(thread.id, thread)
      message = post(due.createdBy, thread, { ...body, ...(due.labels ? { labels: due.labels } : {}) })
    }
    due.sent = n + 1
    due.lastMessageId = message.id
    due.revision++
    const next = due.every === undefined ? null : due.firstAt + due.every * due.sent
    const over = next === null || (due.times !== undefined && due.sent >= due.times) || (due.until !== undefined && next > due.until)
    due.nextAt = over ? null : next
    if (over) due.state = 'done'
    return message.id
  }

  function schedulesRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/schedules') return { schedule: showSchedule(schedule(actor, body)) }
    if (method === 'GET' && rest === '/schedules') {
      const query = (name: string) => url.searchParams.get(name) ?? undefined
      const state = query('state')
      const createdBy = query('createdBy')
      const listed = [...schedules.values()].sort((a, b) => a.createdAt - b.createdAt)
      // Filters apply within each page, so a page can come back short with a cursor to the rest.
      const { items, cursor } = page(listed, url.searchParams.get('cursor'), 2)
      const kept = items.filter(
        (s) =>
          (state === undefined || s.state === state) &&
          (query('channelId') === undefined || s.channelId === query('channelId')) &&
          (query('threadId') === undefined || s.threadId === query('threadId')) &&
          (createdBy === undefined || s.createdBy.id === createdBy || principalId(s.createdBy.principal) === createdBy),
      )
      return { schedules: kept.map(showSchedule), cursor }
    }
    if ((found = /^\/schedules\/([^/]+)\/cancel$/.exec(rest)) && method === 'POST') {
      const target = schedules.get(decodeURIComponent(found[1]!))
      if (!target) throw new Refused(404, 'schedule_not_found')
      if (!samePrincipal(target.createdBy.principal, actor.principal)) throw new Refused(403, 'schedule_not_owned')
      if (target.state !== 'pending') return { schedule: showSchedule(target), canceled: false }
      Object.assign(target, { state: 'canceled', nextAt: null, canceled: { by: actor, at: now(), reason: 'canceled' }, revision: target.revision + 1 })
      return { schedule: showSchedule(target), canceled: true }
    }
    return undefined
  }

  /** The sync key a platform location is under: `slack` of `slack:C1:1.2`. */
  const keyOf = (location: string) => location.slice(0, location.indexOf(':'))
  /** A sync's call, for a key the caller's project owns on the board: 403 `sync_key_not_owned` otherwise. */
  function owning(actor: Actor, key: string) {
    if (keyOwners.get(key) !== principalId(actor.principal)) throw new Refused(403, 'sync_key_not_owned', 'This caller syncs no key on this board: register it as a sync entry first.')
  }
  /** A sync's read, for a caller that owns any key here. */
  function syncing(actor: Actor) {
    if (![...keyOwners.values()].includes(principalId(actor.principal))) throw new Refused(403, 'sync_key_not_owned', 'This caller syncs no key on this board: register it as a sync entry first.')
  }
  const platformKey = (thread: string, message: string) => `${thread}|${message}`
  const syncOf = (threadId: string) => {
    const found = syncs.get(threadId) ?? { targets: [], external: {} }
    syncs.set(threadId, found)
    return found
  }

  /** What `/sync/*` and a message's `/synced` answer, as api-messageboard's sync services keep them. */
  function syncRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    const owner = principalId(actor.principal)
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/sync/imports') return { message: syncImport(actor, body) }
    if (method === 'POST' && rest === '/sync/receipts') {
      const message = messageNamed(body.message)
      if (!message) throw new Refused(404, 'message_not_found')
      owning(actor, keyOf(body.target))
      const synced = syncOf(message.threadId)
      if (body.kind === 'thread') {
        if (synced.targets.includes(body.target)) return { ok: true, attached: false }
        synced.targets.push(body.target)
        if (body.targetKind === 'thread') {
          synced.external[body.target] = body.target
          platformThreads.set(body.target, message.threadId)
        }
        // The sync that owns the target hears of it as an `@sync` match, and backfills a channel.
        const thread = threadAt(message.threadId)
        const root = thread.messages[0]!
        emit(thread.channelId, { type: 'thread.synced', threadId: thread.id, message: 1, messageId: root.id, binding: { target: body.target, targetKind: body.targetKind, cause: body.cause } }, actor)
        return { ok: true, attached: true }
      }
      const kept = copies.get(message.id) ?? {}
      copies.set(message.id, kept)
      if (body.kind === 'message') {
        // The first copy recorded stands.
        kept[body.target] ??= { thread: body.external.thread, message: body.external.message, ...(body.files !== undefined ? { files: body.files } : {}), ...(body.external.asUser ? { asUser: true } : {}) }
        platformMessages.set(platformKey(body.external.thread, body.external.message), message.id)
        if (message.sequence === 1 && synced.external[body.target] === undefined) {
          synced.external[body.target] = body.external.thread
          platformThreads.set(body.external.thread, message.threadId)
        }
        delete undelivered.get(message.id)?.[body.target]
      } else if (body.kind === 'files') {
        if (kept[body.target]) kept[body.target]!.files = body.files
      } else if (body.kind === 'failed') {
        undelivered.set(message.id, { ...undelivered.get(message.id), [body.target]: body.error })
      } else throw new Refused(400, 'invalid_request')
      return { ok: true }
    }
    if (method === 'GET' && rest === '/sync/find') {
      syncing(actor)
      const thread = url.searchParams.get('thread') ?? undefined
      const message = url.searchParams.get('message') ?? undefined
      const post = url.searchParams.get('post') ?? undefined
      if (message !== undefined && thread === undefined) throw new Refused(400, 'invalid_find')
      let foundMessage: string | null = post === undefined ? null : (imports.get(`${owner}|${post}`) ?? null)
      if (thread !== undefined && message !== undefined) foundMessage = platformMessages.get(platformKey(thread, message)) ?? foundMessage
      return { thread: thread === undefined ? null : (platformThreads.get(thread) ?? null), message: foundMessage }
    }
    if ((found = /^\/sync\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') {
      syncing(actor)
      const thread = threadAt(decodeURIComponent(found[1]!))
      const synced = syncOf(thread.id)
      // Only the caller's own keys' targets.
      const mine = (target: string) => keyOwners.get(keyOf(target)) === owner
      const targets = synced.targets.filter(mine)
      return { thread: thread.id, root: thread.messages[0]!.id, channel: thread.channelId, targets, external: Object.fromEntries(Object.entries(synced.external).filter(([target]) => mine(target))) }
    }
    if (method === 'GET' && rest === '/sync/copies') {
      syncing(actor)
      const asked = url.searchParams.getAll('message')
      if (asked.length < 1 || asked.length > 100) throw new Refused(400, 'invalid_request')
      const mine = (target: string) => keyOwners.get(keyOf(target)) === owner
      return {
        copies: Object.fromEntries(
          asked.filter((id) => messageNamed(id)).map((id) => [id, Object.fromEntries(Object.entries(copies.get(id) ?? {}).filter(([target]) => mine(target)))]),
        ),
      }
    }
    if (method === 'GET' && rest === '/sync/linked') {
      const thread = url.searchParams.get('thread') ?? ''
      const message = url.searchParams.get('message')
      const id = message !== null ? platformMessages.get(platformKey(thread, message)) : (() => {
        const threadId = platformThreads.get(thread)
        return threadId ? threads.get(threadId)?.messages[0]?.id : undefined
      })()
      const at = id ? messageNamed(id) : undefined
      if (!at) throw new Refused(404, 'message_not_found')
      return { thread: at.threadId, message: at.id }
    }
    if ((found = /^\/messages\/([^/]+)\/synced$/.exec(rest)) && method === 'GET') {
      const message = messageNamed(decodeURIComponent(found[1]!))
      if (!message) throw new Refused(404, 'message_not_found')
      const synced = syncOf(message.threadId)
      const kept = copies.get(message.id) ?? {}
      return {
        targets: synced.targets.map((target) => {
          const external = synced.external[target] ?? null
          const copy = kept[target] ?? (external !== null ? kept[external] : undefined)
          return { target, key: keyOf(target), thread: copy?.thread ?? external, message: copy?.message ?? null, undelivered: undelivered.get(message.id)?.[target] ?? null }
        }),
      }
    }
    if ((found = /^\/sync\/inbox\/([^/]+)(\/next|\/([^/]+)\/ack)?$/.exec(rest))) {
      const key = decodeURIComponent(found[1]!)
      owning(actor, key)
      const lane = inboxes.get(`${owner}|${key}`) ?? []
      inboxes.set(`${owner}|${key}`, lane)
      if (method === 'POST' && found[2] === undefined) {
        // An ID the inbox has had is skipped.
        let queued = 0
        for (const { id, thread, event, raw } of body.events as { id: string; thread: string; event: unknown; raw: unknown }[]) {
          if (lane.some((entry) => entry.id === id)) continue
          lane.push({ id, thread, event, raw, createdAt: now(), attempts: 0, done: false })
          queued++
        }
        return { ok: true, queued }
      }
      if (method === 'GET' && found[2] === '/next') {
        const limit = Number(url.searchParams.get('limit') ?? 10)
        const open = lane.filter((entry) => !entry.done)
        const held = new Set(open.filter((entry) => entry.lease && entry.leaseUntil! > Date.now()).map((entry) => entry.thread))
        const heads = new Map<string, InboxEntry>()
        for (const entry of open) if (!heads.has(entry.thread)) heads.set(entry.thread, entry)
        const free = [...heads.values()].filter((entry) => !held.has(entry.thread)).slice(0, limit)
        for (const entry of free) {
          if (entry.lease) entry.attempts++
          entry.lease = randomUUID()
          entry.leaseUntil = Date.now() + 5 * 60_000
        }
        return { items: free.map(({ id, thread, lease, attempts, event, raw }) => ({ id, key, thread, lease, attempt: attempts, event, raw })) }
      }
      if (method === 'POST' && found[3] !== undefined) {
        const entry = lane.find((one) => one.id === decodeURIComponent(found![3]!) && !one.done)
        if (!entry) throw new Refused(404, 'no_item')
        if (entry.lease !== body.lease) throw new Refused(409, 'stale_lease')
        if (body.error !== undefined) {
          entry.attempts++
          delete entry.lease
        } else entry.done = true
        return { ok: true }
      }
      if (method === 'GET' && found[2] === undefined) {
        return { events: [...lane].reverse().map(({ id, thread, createdAt, event, raw }) => ({ id, thread, createdAt: new Date(createdAt).toISOString(), event, raw })) }
      }
    }
    throw new Refused(404, 'not_found', `${method} ${rest}`)
  }

  /** A platform's write, as its platform user: the board message it wrote or changed, or null for one the sync never brought here. */
  function syncImport(actor: Actor, body: Record<string, any>): string | null {
    const author = body.author as { id: string; handle: string; name: string; avatar?: string | null }
    if (body.op === 'seen') {
      owning(actor, keyOf(author.id))
      externalViews.set(author.id, { id: author.id, kind: 'external', handle: author.handle, name: author.name })
      return null
    }
    const key: string = body.from ?? body.source?.key ?? keyOf(body.origin?.thread ?? author.id)
    owning(actor, key)
    externalViews.set(author.id, { id: author.id, kind: 'external', handle: author.handle, name: author.name })
    const platformUser: Actor = { id: author.id, principal: { type: 'external', id: author.id, syncKey: key } }
    const owner = principalId(actor.principal)
    if (body.op === 'post') {
      if (body.id !== undefined) {
        const again = imports.get(`${owner}|${body.id}`)
        if (again) return again
      }
      const origin = body.origin as (Message['origin'] & { subthread?: string | null }) | null | undefined
      if (origin) {
        // A platform thread is one board thread's, and a platform message one board message's.
        if (body.re === undefined && platformThreads.has(origin.thread)) throw new Refused(409, 'already_synced', `\`${origin.thread}\` is already synced with another thread.`)
        if (platformMessages.has(platformKey(origin.thread, origin.message))) throw new Refused(409, 'already_synced')
      }
      let thread: Thread
      let replyTo: number | undefined
      if (body.re !== undefined) {
        const re = messageNamed(body.re)
        if (!re) throw new Refused(404, 'message_not_found')
        thread = threadAt(re.threadId)
        if (re.sequence > 1) replyTo = re.sequence
        // A reply's platform thread is its own thread's.
        const owner = origin ? platformThreads.get(origin.thread) : undefined
        if (origin && owner !== undefined && owner !== thread.id) throw new Refused(409, 'already_synced')
        if (origin && owner === undefined) throw new Refused(409, 'not_synced', `\`${origin.thread}\` isn't synced with this thread.`)
      } else {
        if (body.channelId === undefined) throw new Refused(400, 'invalid_request', 'A root import names its channelId.')
        const channel = channelAt(body.channelId)
        const createdAt = now()
        thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: platformUser, messages: [] }
        threads.set(thread.id, thread)
      }
      const message = post(platformUser, thread, { text: body.text, ...(replyTo !== undefined ? { replyTo } : {}), ...(body.labels ? { labels: body.labels } : {}) }, {
        ...(body.from !== null && body.from !== undefined ? { from: body.from } : {}),
        ...(origin ? { origin } : {}),
        ...(body.noSync ? { noSync: true } : {}),
      })
      if (origin) {
        // A root binds its thread to the platform thread it came from, as a target, with no feed event.
        if (body.re === undefined) {
          platformThreads.set(origin.thread, thread.id)
          const synced = syncOf(thread.id)
          synced.targets.push(origin.thread)
          synced.external[origin.thread] = origin.thread
        }
        platformMessages.set(platformKey(origin.thread, origin.message), message.id)
        // Its copy on the thread it came from.
        copies.set(message.id, { ...copies.get(message.id), [origin.thread]: { thread: origin.thread, message: origin.message } })
      }
      if (body.id !== undefined) imports.set(`${owner}|${body.id}`, message.id)
      return message.id
    }
    // Every other op finds the message it changes, by its board ID or its platform IDs.
    const id: string | undefined = body.message ?? (body.origin ? platformMessages.get(platformKey(body.origin.thread, body.origin.message)) : undefined)
    const message = id ? messageNamed(id) : undefined
    if (!message) return null
    const thread = threadAt(message.threadId)
    const ref = { threadId: thread.id, message: message.sequence, messageId: message.id, ...(body.from ? { from: body.from } : {}) }
    if ((body.op === 'edit' || body.op === 'delete') && body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict')
    if (body.op === 'edit') {
      if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
      if (message.text !== body.text) {
        Object.assign(message, { text: body.text, editedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
        emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision }, platformUser)
      }
    } else if (body.op === 'delete') {
      if (message.deletedAt === undefined) {
        Object.assign(message, { text: '', attachments: undefined, deletedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
        emit(thread.channelId, { type: 'message.deleted', ...ref, revision: message.revision }, platformUser)
      }
    } else if (body.op === 'react') {
      const by = message.reactions.get(body.emoji) ?? new Map()
      if (body.remove ? by.has(platformUser.id) : !by.has(platformUser.id)) {
        if (body.remove) by.delete(platformUser.id)
        else by.set(platformUser.id, { actor: platformUser, createdAt: now() })
        if (by.size) message.reactions.set(body.emoji, by)
        else message.reactions.delete(body.emoji)
        message.changes++
        emit(thread.channelId, { type: body.remove ? 'message.reaction_removed' : 'message.reaction_added', ...ref, emoji: body.emoji }, platformUser)
      }
    } else if (body.op === 'labels') {
      const changes: Record<string, { from?: string; to?: string }> = {}
      for (const key of (body.unset ?? []) as string[])
        if (Object.hasOwn(message.labels, key)) {
          changes[key] = { from: message.labels[key]! }
          delete message.labels[key]
        }
      for (const [key, value] of Object.entries((body.set ?? {}) as Record<string, string>))
        if (message.labels[key] !== value) {
          changes[key] = { ...(Object.hasOwn(message.labels, key) ? { from: message.labels[key]! } : {}), to: value }
          message.labels[key] = value
        }
      if (Object.keys(changes).length) {
        message.changes++
        emit(thread.channelId, { type: 'message.labeled', ...ref, labels: changes }, platformUser)
      }
    } else if (body.op !== 'links') throw new Refused(400, 'invalid_request')
    return message.id
  }

  async function route(request: Request): Promise<unknown> {
    const url = new URL(request.url)
    if (url.searchParams.get('teamId') && url.searchParams.get('teamId') !== teamId) throw new Refused(403, 'forbidden')
    if (url.searchParams.get('slug') && url.searchParams.get('slug') !== slug) throw new Refused(403, 'forbidden')
    const actor = actorOf(request)
    const path = url.pathname.replace(/^\/v1\/messageboard/, '')
    const method = request.method
    requests.push(`${method} ${path}`)
    // Completing an upload takes no body.
    const body = method === 'GET' || /\/attachments\/[^/]+\/complete$/.test(path) ? {} : ((await request.json()) as Record<string, any>)
    // Registering and acking watchers, and completing uploads, take no operation ID: each is idempotent as it is.
    // Nor do a sync's receipts and inbox, which are idempotent by what they name, or an import of a platform user seen.
    if (method !== 'GET' && !/\/watchers(\/|$)|\/complete$|\/sync\/(receipts|inbox)/.test(path) && body.op !== 'seen' && typeof body.operationId !== 'string') throw new Refused(400, 'invalid_operation_id')
    if (method === 'GET' && path === '/me') return { teamId, actor, view: viewOf(actor) }
    if (method === 'GET' && path === '/boards') return { boards: boardId ? [{ id: boardId, teamId, name: 'General', visibility: 'team' }] : [], defaultBoardId: boardId, cursor: null }
    if (method === 'POST' && path === '/boards/default') {
      // Board creates record a person's event, so project tokens can't.
      if (actor.principal.type === 'project') throw new Refused(403, 'forbidden')
      boardId ??= 'brd_default'
      return { board: { id: boardId, teamId, name: 'General', visibility: 'team' } }
    }
    const onBoard = /^\/boards\/([^/]+)(\/.*)?$/.exec(path)
    if (!onBoard || onBoard[1] !== boardId) throw new Refused(404, 'board_not_found')
    const rest = onBoard[2] ?? ''
    let found: RegExpExecArray | null

    if (method === 'GET' && rest === '') return { board: { id: boardId, teamId, name: 'General', visibility: 'team' } }

    if (method === 'GET' && rest === '/channels') {
      const name = url.searchParams.get('name')
      return { channels: name === null ? channels : channels.filter((c) => c.name === name), cursor: null }
    }
    if (method === 'POST' && rest === '/channels') {
      if (typeof body.name !== 'string' || body.name.length > 80 || !CHANNEL.test(body.name)) throw new Refused(400, 'invalid_channel_name')
      if (channels.some((c) => c.name === body.name)) throw new Refused(409, 'channel_name_taken')
      const channel = { id: `chn_${randomUUID()}`, name: body.name }
      channels.push(channel)
      return { channel }
    }
    if (method === 'GET' && rest === '/threads') {
      const channelId = url.searchParams.get('channelId') ?? ''
      channelAt(channelId)
      const label = url.searchParams.get('label')
      let listed = [...threads.values()].filter((t) => t.channelId === channelId)
      if (label !== null) {
        const [key, value] = label.split('=', 2) as [string, string | undefined]
        listed = listed.filter((t) => Object.hasOwn(t.messages[0]!.labels, key) && (value === undefined || t.messages[0]!.labels[key] === value))
        listed.sort((a, b) => a.createdAt - b.createdAt)
      } else listed.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      const { items, cursor } = page(listed, url.searchParams.get('cursor'), 25)
      return { threads: items.map(showThread), cursor }
    }
    if (method === 'POST' && rest === '/threads') {
      const again = repeat(actor, body.clientId)
      if (again) return again
      const channel = channelAt(body.channelId)
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: actor, messages: [] }
      threads.set(thread.id, thread)
      const message = post(actor, thread, body as { text: string; clientId?: string; labels?: Record<string, string>; attachments?: string[] })
      return { thread: showThread(thread), message: show(message) }
    }
    if ((found = /^\/messages\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const id = /^msg_([0-9a-f-]{36})_([1-9]\d*)$/.exec(decodeURIComponent(found[1]!))
      if (!id) throw new Refused(404, 'message_not_found')
      const thread = threads.get(`thr_${id[1]}`)
      const message = thread?.messages[Number(id[2]) - 1]
      if (!thread || !message) throw new Refused(404, 'message_not_found')
      return { thread: showThread(thread), message: show(message) }
    }
    if ((found = /^\/posts\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const again = repeat(actor, decodeURIComponent(found[1]!))
      if (!again) throw new Refused(404, 'post_not_found')
      return again
    }
    if (rest === '/watchers' || rest.startsWith('/watchers/')) return watchers(method, rest, actor, body, url)
    if (rest.startsWith('/sync/') || /^\/messages\/[^/]+\/synced$/.test(rest)) return syncRoute(method, rest, actor, body, url)
    if (rest === '/schedules' || rest.startsWith('/schedules/')) {
      const answered = schedulesRoute(method, rest, actor, body, url)
      if (answered !== undefined) return answered
    }
    if (method === 'POST' && rest === '/attachments') {
      const attachment: Attachment = { id: `att_${randomUUID()}`, boardId: boardId!, name: body.name, type: body.type, size: body.size, sha256: body.sha256, state: 'pending', createdAt: now(), createdBy: actor }
      attachments.set(attachment.id, attachment)
      return { attachment, upload: { url: `${STORAGE}${attachment.id}`, method: 'PUT', headers: { 'content-type': body.type, 'x-amz-checksum-sha256': body.sha256 }, expiresAt: now() + 600_000 } }
    }
    if ((found = /^\/attachments\/([^/]+)(\/complete)?$/.exec(rest))) {
      const attachment = attachments.get(decodeURIComponent(found[1]!))
      const own = attachment && samePrincipal(attachment.createdBy.principal, actor.principal)
      if (method === 'POST' && found[2]) {
        if (!attachment || !own) throw new Refused(404, 'attachment_not_found')
        const bytes = stored.get(attachment.id)
        if (!bytes) throw new Refused(409, 'attachment_not_uploaded')
        if (bytes.byteLength !== attachment.size) throw new Refused(422, 'attachment_mismatch')
        attachment.state = 'ready'
        return { attachment }
      }
      if (method === 'GET' && !found[2]) {
        const posted = attachment?.messageId ? MESSAGE_ID.exec(attachment.messageId) : null
        const message = posted ? threads.get(`thr_${posted[1]}`)?.messages[Number(posted[2]) - 1] : undefined
        if (!attachment || attachment.state !== 'ready' || !(own || (message && message.deletedAt === undefined))) throw new Refused(404, 'attachment_not_found')
        return { attachment, url: `${STORAGE}${attachment.id}`, expiresAt: now() + 60_000 }
      }
    }
    if (method === 'GET' && rest === '/actors') return { actors: [...actors.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt), cursor: null }
    if (method === 'GET' && rest === '/messages') {
      const channelId = url.searchParams.get('channelId') ?? ''
      channelAt(channelId)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Refused(400, 'invalid_request')
      const head = feeds.get(channelId)?.length ?? 0
      const listed = [...threads.values()].filter((t) => t.channelId === channelId).flatMap((t) => t.messages).sort((a, b) => a.feedSequence - b.feedSequence)
      const after = url.searchParams.get('after')
      if (after === null) return { messages: listed.slice(-limit).map(show), cursor: cursorAt(channelId, head) }
      const from = positionOf(channelId, after)
      const taken = listed.filter((m) => m.feedSequence > from).slice(0, limit)
      const more = listed.filter((m) => m.feedSequence > from).length > limit
      return { messages: taken.map(show), cursor: cursorAt(channelId, more ? taken.at(-1)!.feedSequence : head) }
    }
    if (method === 'GET' && rest === '/changes') {
      const channelId = url.searchParams.get('channelId') ?? ''
      channelAt(channelId)
      const feed = () => feeds.get(channelId) ?? []
      const cursor = url.searchParams.get('cursor')
      if (cursor !== null && url.searchParams.get('from') !== null) throw new Refused(400, 'invalid_cursor')
      const from = url.searchParams.get('from') === 'latest' ? feed().length : cursor === null ? 0 : positionOf(channelId, cursor)
      // A long-poll holds until the next change, as the API's does.
      const until = Date.now() + Math.min(Number(url.searchParams.get('wait') ?? 0), 25) * 1000
      while (feed().length === from && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
      const include = url.searchParams.get('include') === 'message'
      const events = feed()
        .slice(from, from + 48)
        .map((change, i) => {
          const message = include && change.messageId ? messageNamed(change.messageId) : undefined
          return { ...change, cursor: cursorAt(channelId, from + i + 1), ...(message ? { currentMessage: show(message) } : {}) }
        })
      return { events, cursor: cursorAt(channelId, from + events.length), caughtUp: from + events.length >= feed().length }
    }
    if ((found = /^\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') return { thread: showThread(threadAt(found[1]!)) }
    if ((found = /^\/threads\/([^/]+)\/messages$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      if (method === 'GET') {
        const { items, cursor } = page(thread.messages, url.searchParams.get('cursor'), 50)
        return { messages: items.map(show), cursor }
      }
      const again = repeat(actor, body.clientId)
      if (again) return again
      return { thread: showThread(thread), message: show(post(actor, thread, body as { text: string; replyTo?: number; clientId?: string; attachments?: string[]; after?: number })) }
    }
    if ((found = /^\/threads\/([^/]+)\/messages\/(\d+)(\/delete|\/reactions|\/labels)?$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      const message = messageAt(thread.id, Number(found[2]))
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      const action = found[3] ?? ''
      if (method === 'PATCH' && action === '') {
        if (!samePrincipal(message.createdBy.principal, actor.principal)) throw new Refused(403, 'message_not_owned')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        if (message.text !== body.text) {
          Object.assign(message, { text: body.text, editedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision }, actor)
        }
        return { message: show(message) }
      }
      if (method === 'POST' && action === '/delete') {
        if (!samePrincipal(message.createdBy.principal, actor.principal)) throw new Refused(403, 'message_not_owned')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt === undefined) {
          Object.assign(message, { text: '', attachments: undefined, deletedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.deleted', ...ref, revision: message.revision }, actor)
        }
        return { message: show(message) }
      }
      if (method === 'GET' && action === '/reactions') {
        const reactions = [...message.reactions].flatMap(([emoji, by]) => [...by.values()].map(({ actor, createdAt }) => ({ emoji, actor, createdAt })))
        return { reactions, cursor: null }
      }
      if (method === 'POST' && action === '/reactions') {
        if (typeof body.emoji !== 'string' || !EMOJI.test(body.emoji) || Object.hasOwn(Object.prototype, body.emoji)) throw new Refused(400, 'invalid_emoji')
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        const by = message.reactions.get(body.emoji) ?? new Map()
        if (body.remove ? by.has(actor.id) : !by.has(actor.id)) {
          if (body.remove) by.delete(actor.id)
          else by.set(actor.id, { actor, createdAt: now() })
          if (by.size) message.reactions.set(body.emoji, by)
          else message.reactions.delete(body.emoji)
          message.changes++
          emit(thread.channelId, { type: body.remove ? 'message.reaction_removed' : 'message.reaction_added', ...ref, emoji: body.emoji }, actor)
        }
        return { meta: meta(message) }
      }
      if (method === 'POST' && action === '/labels') {
        const set = (body.set ?? {}) as Record<string, string>
        const unset = (body.unset ?? []) as string[]
        if (unset.some((key) => Object.hasOwn(set, key))) throw new Refused(400, 'invalid_label')
        // What the labels must be now, checked with the change: a value, or null for none.
        for (const [key, want] of Object.entries((body.if ?? {}) as Record<string, string | null>).sort(([a], [b]) => (a < b ? -1 : 1))) {
          const now = Object.hasOwn(message.labels, key) ? message.labels[key] : undefined
          if (now !== (want ?? undefined)) throw new Refused(409, 'label_conflict', want === null ? `${key} is set` : now === undefined ? `${key} isn't set` : `${key} isn't ${want}`)
        }
        const changes: Record<string, { from?: string; to?: string }> = {}
        for (const key of unset)
          if (Object.hasOwn(message.labels, key)) {
            changes[key] = { from: message.labels[key]! }
            delete message.labels[key]
          }
        for (const [key, value] of Object.entries(set))
          if (message.labels[key] !== value) {
            changes[key] = { ...(Object.hasOwn(message.labels, key) ? { from: message.labels[key]! } : {}), to: value }
            message.labels[key] = value
          }
        if (Object.keys(message.labels).length > 16) throw new Refused(400, 'too_many_labels')
        if (Object.keys(changes).length) {
          message.changes++
          emit(thread.channelId, { type: 'message.labeled', ...ref, labels: changes }, actor)
        }
        return { meta: meta(message) }
      }
    }
    throw new Refused(404, 'not_found', `${method} ${path}`)
  }

  return {
    /** Every request it answered, as `METHOD /path`. */
    requests,
    /** The watchers each principal registered, as the API keeps them. */
    registrations,
    /** Every schedule, by ID, as the API keeps them. */
    schedules,
    /** Posts a schedule's next send now, as its timer would: the message's ID. */
    send,
    /** The attachments bucket, as presigned URLs reach it: a PUT stores bytes, held to its signed SHA-256 as S3 holds it, and a GET reads them. */
    files: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const id = request.url.slice(STORAGE.length)
      if (request.headers.has('authorization')) return new Response('credentials never go to storage', { status: 400 })
      if (request.method === 'PUT') {
        if (stored.has(id)) return new Response(null, { status: 412 })
        const bytes = new Uint8Array(await request.arrayBuffer())
        const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))
        if (request.headers.get('x-amz-checksum-sha256') !== digest) return new Response('BadDigest', { status: 400 })
        stored.set(id, bytes)
        return new Response(null, { status: 200 })
      }
      const bytes = stored.get(id)
      return bytes ? new Response(bytes) : new Response(null, { status: 404 })
    }) as typeof fetch,
    /** The API, as `fetch` reaches it. */
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      try {
        return Response.json(await route(request))
      } catch (error) {
        if (error instanceof Refused) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        throw error
      }
    }) as typeof fetch,
  }
}

/** A fetch to `api` as `principal` (`user:u_jb`, `project:prj_pong:production`): the bearer token the fake reads. */
export const as = (api: ReturnType<typeof fakeMessageboard>, principal: string): typeof fetch =>
  (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${principal}`)
    return api.fetch(input, { ...init, headers })
  }) as typeof fetch
