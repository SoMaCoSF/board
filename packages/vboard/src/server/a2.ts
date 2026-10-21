import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import type { z } from 'zod'
import { A2Error, idempotentId, reducer } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type ConsumerContext } from 'experimental-a2/server'
import {
  boardContract,
  BOARD_SESSION,
  IDENTITY_SESSION,
  identityContract,
  inboxContract,
  INBOXES_SESSION,
  inboxSession,
  SCHEDULES_SESSION,
  type BoardEvent,
  type BoardEvents,
  type ExternalAuthor,
  type InboxEvent,
  type Link,
} from '../contract/contract.ts'
import { actorsReducer, channelsReducer, identityCodesReducer, linkedTo, type ExternalCopy, type IdentityCode } from '../contract/reducers.ts'
import { RemoteWatcherId, type Author } from '../contract/schemas.ts'
import type { InboxEntry, LinkedAccount, Me } from '../api/routes.ts'
import { FULL_ACCESS, type Access, type Permission } from './access.ts'
import { authenticates, createAuthority, issuersOf, type AccessFunction, type AccessRule, type Granted } from './auth.ts'
import { actorSeen } from './actors.ts'
import { SYNC, type Backend, type BackendRoute, type BoardBinding, type Caller, type ProtocolMethods } from './backend.ts'
import { attachmentBody, attachmentNotFound, defaultBlob, readUpload, writeUpload, type BlobStore } from './blob.ts'
import { badRequest, forbidden, HttpError, notFound, toErrorResponse } from './errors.ts'
import { eventView, foldEvent, indexOf, loadBefore, OWN_CODE, personView, pollFeed, readableFilter, ref, toMessageFilter, view } from './feed.ts'
import { createReads, tablesConsumer } from './reads.ts'
import { createdBy, createSchedules, type Schedule } from './schedules.ts'
import { defaultStore } from '../store/default.ts'
import type { BoardStore, MessageFilter } from '../store/types.ts'
import { compileWatcher, createWatchers, ID, registrantSession } from './watch.ts'
import { ack, pull, pullInbox, type QueueSession } from './registered.ts'
import { createRegistry, storedPrincipal, type Registration, type SyncEntrySpec } from './registry.ts'
import { METHODS } from './routing.ts'
import { publicPost, type Post } from './transport.ts'
import {
  authorizeMessage,
  authorizeOwn,
  authorizePost,
  trusted,
  writeAttach,
  writeDelete,
  writeEdit,
  writeLabels,
  writeLinks,
  writePost,
  writeReaction,
  deploymentIdentity,
  landedFor,
  type Identity,
  type WriteContext,
} from './writes.ts'
import { MIDDLEWARE_ACTOR } from './middleware.ts'
import { localScheduler } from '../scheduler/local.ts'

/** `a2()`'s options: the board in this deployment, on A2's log, and everything that runs beside it. */
export type A2Options = {
  /**
   * Where the board keeps its log and tables: `postgres()`, `sqlite()`, or `memory()` from
   * `vboard/backend-a2/store-*`. Omitted: SQLite in development, memory in tests. Required in production.
   */
  store?: BoardStore
  /**
   * What runs the board's consumers, retries, and timers: `vercelQueues()` or `qstash()` from
   * `vboard/backend-a2/scheduler-*`. Mount the backend's `scheduler` as `POST` in its own route.
   * Omitted: one in this process in development, with tasks in memory, and none in tests.
   * Required in production.
   */
  scheduler?: A2Scheduler
  /**
   * Where attachments live: `vercelBlob()` from `vboard/backend-a2/blob-vercel`. Omitted: memory
   * in tests, `.a2/attachments` in development. Required in production.
   */
  blob?: BlobStore
  /**
   * Who besides the board's people and its own deployments in the environment it runs in may use
   * it, and what they may do in each channel: `vercelProject()`, `githubActions()`, `oidc()` from
   * `vboard/access`. The first rule that matches a token decides. A production board's previews
   * need a rule, as `vercelProject({ project: 'self', environments: ['preview'], can })`.
   *
   * Or a host's own model: a function of the principal its `board({ authenticate })` returned, giving
   * what it may do in each channel (`'all'`, `['read']`, `{ 'dev/': ['post'] }`), or null for nothing.
   * Nothing else is trusted then, not the board's own people or deployments.
   */
  access?: readonly AccessRule[] | AccessFunction
  /** For tests: how the board POSTs wake-ups to boards on `http()`. Defaults to https to public addresses only. */
  transport?: { post?: Post }
}

const boardServer = (options: A2Options) =>
  createServer({
    contract: boardContract,
    ...(options.store?.log ? { store: options.store.log } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })

export type BoardSession = ReturnType<ReturnType<typeof boardServer>['session']>

/** Sync's own lookups and receipts, from board() in this deployment. */
const SYNC_ACTOR = 'vboard:sync'
/** The board's own code, through its handle: `team.post(…)`. With `as(profile)`, `vboard:client:<profile>`. */
const CLIENT_ACTOR = 'vboard:client'

/** A cursor or message ref in a request, as this board's log index: decimals, from 0. */
function cursorAt(value: string): number {
  const index = indexOf(value)
  if (index === null) throw badRequest(`${value} isn't a cursor or a message ID on this board`, 'invalid_cursor')
  return index
}

/** The message a ref in a request names, as its log index, or a 404 for one that names nothing here. */
function messageAt(value: string): number {
  const index = indexOf(value)
  if (index === null || index === 0) throw notFound(`message not found: #${value}`, 'message_not_found')
  return index
}

/** A schedule's ID, `12` or as the CLI shows it, `s12`, as its index in session `schedules`. */
function scheduleAt(value: string): number {
  const bare = value.replace(/^s/, '')
  const index = indexOf(bare)
  if (index === null || index === 0) throw notFound(`schedule not found: s${bare}`, 'schedule_not_found')
  return index
}

/** A wake-up only has to arrive: the board it wakes runs what it pulls before it answers. */
const WAKE_TIMEOUT_MS = 5000

/**
 * `idempotentId`'s shape, a UUIDv8: the IDs the board derives for its own writes (schedule
 * sends, watchers, sync). They're guessable, so an API caller can't post with one and take it first.
 */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A request to the board, as opposed to a write the board's own code makes in-process. */
const fromRequest = (caller: Caller) => 'identity' in caller && (caller.origin.via?.kind ?? 'api') === 'api'

/** Sync in board() in this deployment, as opposed to a sync elsewhere that uses this board. */
const ownSync = (caller: Caller) => 'self' in caller && caller.origin.via?.kind === 'engine'

/**
 * Who a caller writes as. This deployment's own code writes as `vboard:client` from a handle,
 * `vboard:client:<profile>` from `as(profile)`, as `vboard:watch:<id>` from a watcher, which its
 * own writes never wake, and as `vboard:middleware` and `vboard:sync` from board()'s middleware
 * and sync.
 */
function selfIdentity(caller: Extract<Caller, { self: string | null }>): Identity {
  const { self, origin } = caller
  if (origin.via?.kind === 'watcher') return deploymentIdentity(`vboard:watch:${self}`, self ?? 'watch')
  if (origin.via?.kind === 'middleware') return deploymentIdentity(MIDDLEWARE_ACTOR, 'middleware')
  if (origin.via?.kind === 'engine') return deploymentIdentity(SYNC_ACTOR, 'sync')
  if (self === null) return deploymentIdentity(CLIENT_ACTOR, 'client')
  if (!ID.test(self)) throw badRequest(`as: profiles use lowercase letters, numbers, - and _, got: ${self}`)
  return deploymentIdentity(`${CLIENT_ACTOR}:${self}`, self)
}

/** A platform user, writing through sync: full access, and each write still proved against the channel it lands in. */
function externalIdentity(author: ExternalAuthor): Identity {
  const principal: Granted = { id: author.id, kind: 'external', handle: author.handle, access: FULL_ACCESS, expiresAt: null }
  return {
    principal,
    author: { actor: author.id, principal: author.id, profile: null, session: null },
    actor: { id: author.id, kind: 'external', handle: author.handle, name: author.name, avatar: author.avatar },
  }
}

/**
 * A one-time code for linking an account: `vb-` and eight letters and digits that
 * can't be misread. Only its hash is kept.
 */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 10 * 60_000
const newCode = () => {
  const letters = [...randomBytes(8)].map((byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('')
  return `vb-${letters.slice(0, 4)}-${letters.slice(4)}`
}
const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase()).digest('base64url')

/** The board events sync delivers: what a platform shows, and a thread's new targets. */
const DELIVERED = ['thread.synced', 'message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed'] as const

/** The inboxes that have had an event, so a sync key's inbox lists every channel's. */
const inboxesReducer = reducer({
  contract: inboxContract,
  name: 'vboard.inboxes.v1',
  initialState: {} as Record<string, true>,
}).fold((state, event) => {
  if (event.type === 'inbox.opened') state[event.payload.channel] = true
  return state
})

/** A platform event in an inbox. */
type Received = Extract<InboxEvent, { type: 'external.received' }>
type PlatformEvent = Received['payload']['event']

/** An append that holds an event ID already in the log. */
const duplicate = (error: unknown) => error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH'

/**
 * The options with what every board on `a2()` needs filled in, so the whole protocol works in
 * every environment: in development, a scheduler in this process. In production nothing is
 * assumed, and `missing` names what isn't there. The board says so on its first use rather than
 * when it's created, since a build loads the route without its runtime environment.
 */
function complete(options: A2Options): { options: A2Options; missing: string | null } {
  const env = process.env.NODE_ENV
  if (env === 'production') {
    const missing = (['store', 'scheduler', 'blob'] as const).filter((key) => options[key] === undefined)
    return {
      options,
      missing:
        missing.length === 0
          ? null
          : `a2() needs ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} in production: postgres() from ` +
            'vboard/backend-a2/store-postgres, vercelQueues() from vboard/backend-a2/scheduler-vercel, and vercelBlob() from vboard/backend-a2/blob-vercel, say',
    }
  }
  // Tests bring their own, or none, so nothing runs on a timer they didn't ask for.
  return { options: options.scheduler || env === 'test' ? options : { ...options, scheduler: localScheduler() }, missing: null }
}

/** Everything behind a board on `a2()`, built once board() binds it. Nothing in it connects until it's used. */
function build(options: A2Options, binding: BoardBinding) {
  const blob = options.blob ?? defaultBlob()
  const store = options.store ?? defaultStore()
  // The same A2 store object for every server: A2 recognizes its own stores by identity.
  const log = store.log
  const registry = createRegistry({ store: log, scheduler: options.scheduler })
  // What callers may do, under this board's rules: requests, and stored principals.
  const authority = createAuthority({ access: options.access ?? [], project: binding.project })
  /** Who a caller is, and what it may do now: a request under the rules, this deployment's own code everything. */
  const identityOf = async (caller: Caller): Promise<Identity> => {
    if (!('identity' in caller)) return selfIdentity(caller)
    const { principal } = caller.identity
    return { ...caller.identity, principal: { ...principal, access: await authority.grant(principal) } }
  }
  const post = options.transport?.post ?? publicPost
  const tails = Object.fromEntries(
    Object.entries(binding.subscriptions).flatMap(([id, subscription]) => (subscription.kind === 'tail' ? [[id, { tail: subscription.tail, when: subscription.when }]] : [])),
  )
  // Always, since boards on http() may register watchers here at any time.
  const watchers = createWatchers({
    watch: tails,
    run: (id, event, trigger, attempt) => binding.run(id, event, { trigger, attempt }),
    store: log,
    scheduler: options.scheduler,
    registered: { state: registry.state, accessNow: (principal) => authority.accessNow(principal), wake },
  })
  const schedules = createSchedules({ store: log, scheduler: options.scheduler })
  const projection = tablesConsumer(store.tables)

  /** Sync's delivery in progress here: its receipts are its consumer's appends, fenced by its attempt. */
  const delivering = new AsyncLocalStorage<ConsumerContext<BoardEvents>>()

  /**
   * Sync's outbound, when board() syncs: each event it delivers, on its thread's lane, with its own
   * place in the log, so no watcher holds it up. A2 retries what throws, and dead-letters it after 10.
   */
  const outbound = binding.subscriptions[SYNC]
    ? consumer({
        contract: boardContract,
        name: 'vboard-sync',
        types: DELIVERED,
        lane: ({ event }) => `thread:${(event.payload as { thread: string }).thread}`,
      }).run(async (ctx) => {
        const event = ctx.event as BoardEvent
        const [messages, { state: actors }] = await Promise.all([
          loadBefore(reads, event, ctx.signal),
          ctx.session.state(actorsReducer, { through: event.index - 1 }),
        ])
        const { before, after } = foldEvent(messages, actors, event)
        // A thread's sync is about its root, which came before it.
        const about = event.type === 'thread.synced' ? ((await reads.ensure(event.index - 1, ctx.signal), await store.tables.byEventId(event.payload.thread)) ?? undefined) : after
        // A label change re-renders a copy only when the labels change what it shows: sync compares them.
        const shown = { ...eventView(event, about, actors, OWN_CODE), ...(event.type === 'labels.changed' && before ? { before: view(before, actors, OWN_CODE) } : {}) }
        await delivering.run(ctx as ConsumerContext<BoardEvents>, () => binding.run(SYNC, shown, { trigger: ctx.event.id, attempt: ctx.attempt }))
      })
    : undefined

  // The tables, watchers, and sync each keep their own place in the board's log.
  const consumers = [projection, watchers.boardConsumer, outbound].filter((consumer) => consumer !== undefined)
  const server = createServer({
    contract: boardContract,
    ...(log ? { store: log } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers,
  })
  const session = server.session(BOARD_SESSION)
  const reads = createReads(store.tables, session, projection)
  const writes: WriteContext = { session, reads }

  /** Sync's inbound: each platform event board()'s sync pushed here, one platform thread at a time. */
  const inbound = consumer({
    contract: inboxContract,
    name: 'vboard-inbox',
    types: ['external.received'],
    lane: ({ event }) => `thread:${event.payload.event.thread}`,
  }).run(async (ctx) => {
    const { payload } = ctx.event as Received
    await binding.receive(payload.sync, { event: payload.event, raw: payload.raw }, { id: ctx.event.id, attempt: ctx.attempt, signal: ctx.signal })
  })
  const inboxServer = createServer({
    contract: inboxContract,
    ...(log ? { store: log } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [inbound],
  })
  const identityServer = createServer({ contract: identityContract, ...(log ? { store: log } : {}) })
  const codes = identityServer.session(IDENTITY_SESSION)
  const inboxes = inboxServer.session(INBOXES_SESSION)
  /** The inboxes this instance knows have an `inbox.opened`, so most pushes write nothing more. */
  const opened = new Set<string>()

  // A schedule sends with what its creator may do now, which `access` says at each send. It posts
  // through the board, as its creator, so the board's middleware sees it.
  schedules.bind({ writes, accessNow: authority.accessNow, clientAs: (identity, origin) => binding.client({ identity, origin }, null) })
  watchers.bind({ reads })

  /**
   * Whether `principal` may have a file: one it uploaded, or one a message it
   * can read carries. A deleted message drops its files, so it no longer counts.
   */
  async function attachmentReadable(principal: Granted, id: string, uploadedBy: string | null) {
    if (principal.access.readsAll || uploadedBy === principal.id) return true
    await reads.ensure()
    return (await reads.tables.withAttachment(id)).some((message) => principal.access.readable(message.channel))
  }

  /**
   * `filter`, narrowed to the channels `access` reads among those the log has,
   * and the index that list reflects: a read's cursor goes no further, or the
   * first post in a channel newer than the list would be in neither the page
   * nor the feed after it.
   */
  async function readable(filter: MessageFilter, access: Access): Promise<{ filter: MessageFilter; through: number }> {
    if (access.readsAll) return { filter, through: Number.POSITIVE_INFINITY }
    const { state, index } = await session.state(channelsReducer)
    return { filter: readableFilter(filter, Object.keys(state), access), through: index }
  }

  /** Who wrote, was mentioned, or reacted in the channels `access` reads, a page at a time. */
  async function actorsIn(access: Access): Promise<Set<string>> {
    const ids = new Set<string>()
    const { filter } = await readable({}, access)
    for (let before: number | undefined; ; ) {
      const { messages } = await reads.messages(filter, { limit: 500, ...(before !== undefined ? { before } : {}) })
      for (const message of messages) {
        ids.add(message.by.actor)
        for (const id of message.mentions) ids.add(id)
        for (const reactors of Object.values(message.reactions)) for (const id of reactors) ids.add(id)
      }
      if (messages.length < 500) return ids
      before = messages[0]!.id
    }
  }

  /** Files a write carries, as the board stored them: each one the caller may have, or 404 as if it didn't exist. */
  const attachmentsFor = (principal: Granted, ids: readonly string[] | undefined) =>
    Promise.all(
      [...new Set(ids ?? [])].map(async (id) => {
        const { attachment, uploadedBy } = await readUpload(blob, id)
        if (!(await attachmentReadable(principal, id, uploadedBy))) throw attachmentNotFound(id)
        return attachment
      }),
    )

  /**
   * Tells a registrant's board it has matches to pull, with no event and no token in it: its
   * board pulls them with its own credentials. The hash says whether its registration is stale.
   * Says whether the wake-up got there: an answer, or still pulling when the wait ran out.
   */
  async function wake(registration: Registration): Promise<boolean> {
    if (registration.url === null) return true
    try {
      const response = await post(`${registration.url}/wake`, {
        headers: { 'content-type': 'application/json', 'x-board-watchers': registration.hash },
        body: '{}',
        // Its board runs what it pulls before it answers; the wake-up only has to arrive.
        signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
      })
      if (response.ok) return true
      console.error(`[vboard] couldn't wake ${registration.url}: ${response.status}`)
      return false
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') return true
      console.error(`[vboard] couldn't wake ${registration.url}:`, (error as Error).message)
      return false
    }
  }
  /** A registrant's queue, in the watch contract: its watchers' and sync's matches, and its inbox. */
  const queueOf = (owner: string) => watchers.server.session(registrantSession(owner))

  const methods: ProtocolMethods = {
    async me(caller) {
      const { principal, author, actor } = (await identityOf(caller))
      const body: Me = {
        actor: actor.id,
        principal: principal.id,
        kind: actor.kind,
        handle: actor.handle,
        name: actor.name,
        avatar: actor.avatar,
        profile: author.profile,
        session: author.session,
        expiresAt: principal.expiresAt?.toISOString() ?? null,
        can: principal.access.summary(),
      }
      return body
    },
    async channels(caller) {
      const { principal } = (await identityOf(caller))
      const { state, index } = await session.state(channelsReducer)
      const channels = Object.values(state)
        .filter((channel) => principal.access.readable(channel.path))
        .sort((a, b) => a.path.localeCompare(b.path))
      return { channels, cursor: ref(index) }
    },
    async actors(caller) {
      const { principal, actor } = (await identityOf(caller))
      const { state, index } = await session.state(actorsReducer)
      // A reader of every channel sees everyone; anyone else, who wrote, was mentioned, or reacted where they read, and themselves.
      let seen: ((id: string) => boolean) | null = null
      if (!principal.access.readsAll) {
        const ids = await actorsIn(principal.access)
        ids.add(actor.id)
        seen = (id) => ids.has(id)
      }
      const actors = Object.values(state.byId)
        .filter((a) => seen === null || seen(a.id))
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .map((a) => {
          const person = personView(state, a.id)
          return person ? { ...a, person } : a
        })
      return { actors, cursor: ref(index) }
    },
    async identity(caller) {
      const { principal } = (await identityOf(caller))
      const { state, index } = await session.state(actorsReducer)
      const links = linkedTo(state, principal.id).map((id) => ({
        actor: id,
        handle: state.byId[id]?.handle ?? null,
        name: state.byId[id]?.name ?? null,
        method: state.links[id]!.method,
        at: state.links[id]!.at,
      }))
      // The entries this board links accounts on that have none of the caller's yet.
      const unlinked = (await linkable())
        .filter((entry) => !links.some((link) => link.actor.startsWith(`${entry.platform}:user:`)))
        .map((entry) => entry.key)
      return { principal: principal.id, links, unlinked, cursor: ref(index) }
    },
    async messages(caller, query) {
      const { principal, actor } = (await identityOf(caller))
      const { state: actors } = await session.state(actorsReducer)
      const { filter, through } = await readable(toMessageFilter(query, { me: actor.id, actors }), principal.access)
      const { messages, position } = await reads.messages(filter, {
        ...(query.before !== undefined ? { before: cursorAt(query.before) } : {}),
        ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
        limit: query.limit ?? 50,
      })
      const reader = await reads.reader(principal.access, messages)
      return { messages: messages.map((m) => view(m, actors, reader)), cursor: ref(Math.min(position, through)) }
    },
    async threads(caller, query) {
      const { principal, actor } = (await identityOf(caller))
      const { state: actors } = await session.state(actorsReducer)
      const { filter, through } = await readable(toMessageFilter(query, { me: actor.id, actors }), principal.access)
      const { threads, position } = await reads.threads(filter, {
        ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
        limit: query.limit ?? 50,
      })
      const reader = await reads.reader(principal.access, threads.flatMap((t) => (t.last ? [t.root, t.last] : [t.root])))
      return {
        threads: threads.map((t) => ({ message: view(t.root, actors, reader), replies: t.replies, last: t.last && view(t.last, actors, reader) })),
        cursor: ref(Math.min(position, through)),
      }
    },
    async message(caller, { id }, signal) {
      const { principal } = (await identityOf(caller))
      const at = messageAt(id)
      const message = await reads.message(at, signal)
      if (!message || !principal.access.readable(message.channel)) throw notFound(`message not found: #${at}`, 'message_not_found')
      const [{ messages, cursor }, { state: actors }] = await Promise.all([reads.thread(message.re ?? message.id, signal), session.state(actorsReducer)])
      const [root, ...replies] = messages
      const reader = await reads.reader(principal.access, messages)
      return {
        message: view(root!, actors, reader),
        replies: replies.map((reply) => view(reply, actors, reader)),
        cursor: ref(cursor),
        schedules: await schedules.forThread(root!.id),
      }
    },
    async posted(caller, { id }, signal) {
      const identity = (await identityOf(caller))
      const landed = await reads.byEventId(id, signal)
      const shown = landed ? await landedFor(writes, identity, landed) : null
      if (!shown) throw notFound(`no post of yours has id ${id}`, 'post_not_found')
      return { message: shown }
    },
    async post(caller, parsed) {
      const identity = (await identityOf(caller))
      const { principal } = identity
      const body = { ...parsed, re: parsed.re === undefined ? undefined : messageAt(parsed.re) }
      const proofs = await authorizePost(writes, principal.access, body)
      if (fromRequest(caller) && body.id !== undefined && DERIVED_ID.test(body.id))
        throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
      // A client elsewhere derives its posts' IDs from its key, under its own principal, so no
      // one else can post with one first and make its retry fail.
      if (fromRequest(caller) && body.id?.startsWith('key:') && !body.id.startsWith(`key:${principal.id}:`))
        throw badRequest(`id: key:… IDs derive from a client's key, and this token's are key:${principal.id}:…`)
      const attachments = await attachmentsFor(principal, body.attachments)
      const { schedule, config } = caller.origin
      const { unknownMentions, ...message } = await writePost(writes, {
        attachments,
        identity,
        proofs,
        channel: body.channel,
        re: body.re,
        text: body.text,
        labels: body.labels,
        noSync: body.noSync,
        id: body.id,
        sync: body.sync,
        config,
        // A schedule's send, which only this board's own schedules make: a handle that's ambiguous since it was checked stays plain text.
        ...(schedule && !fromRequest(caller) ? { schedule, lenientMentions: true } : {}),
      })
      return { message, ...(unknownMentions ? { unknownMentions } : {}) }
    },
    async edit(caller, { id, text }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeOwn(writes, identity.principal, messageAt(id), 'edit')
      const { unknownMentions } = await writeEdit(writes, { identity, authorized, text })
      return { ok: true, ...(unknownMentions ? { unknownMentions } : {}) }
    },
    async delete(caller, { id }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeOwn(writes, identity.principal, messageAt(id), 'delete')
      await writeDelete(writes, { identity, authorized })
      return { ok: true }
    },
    async react(caller, { id, emoji, remove }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'react', messageAt(id))
      await writeReaction(writes, { identity, authorized, emoji, remove })
      return { ok: true }
    },
    async label(caller, { id, set, unset }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'label', messageAt(id))
      await writeLabels(writes, { identity, authorized, set, unset })
      return { ok: true }
    },
    async schedule(caller, parsed) {
      const identity = (await identityOf(caller))
      const body = { ...parsed, re: parsed.re === undefined ? undefined : messageAt(parsed.re) }
      // Checked now, where the caller sees it, and again at every send.
      await authorizePost(writes, identity.principal.access, body)
      const attachments = await attachmentsFor(identity.principal, body.attachments)
      return schedules.create(identity, body, attachments)
    },
    async schedules(caller, query) {
      const { principal } = (await identityOf(caller))
      let root: number | undefined
      if (query.re !== undefined) {
        const at = messageAt(query.re)
        root = (await authorizeMessage(writes, principal.access, 'read', at)).message.re ?? at
      }
      const visible = (schedule: Schedule) => principal.access.readable(schedule.channel) || createdBy(schedule, principal)
      return { schedules: await schedules.list({ ...query, ...(root !== undefined ? { root } : {}) }, visible) }
    },
    async cancelSchedule(caller, { id }) {
      return schedules.cancel((await identityOf(caller)), scheduleAt(id))
    },
    async upload(caller, { data, name, type }) {
      const { principal } = (await identityOf(caller))
      // A file is no use until a post or an import carries it, so uploading needs `post` or `sync` somewhere.
      if (!principal.access.anywhere('post') && !principal.access.anywhere('sync')) throw forbidden("this token can't post anywhere, so it can't upload")
      return { attachment: await writeUpload(blob, { data, name, type, uploadedBy: principal.id }) }
    },
    async attachment(caller, { id }) {
      const { principal } = (await identityOf(caller))
      const { attachment, uploadedBy } = await readUpload(blob, id)
      if (!(await attachmentReadable(principal, attachment.id, uploadedBy))) throw attachmentNotFound(attachment.id)
      return { attachment, data: await attachmentBody(blob, attachment.id) }
    },
    async watchers(caller) {
      const { principal } = (await identityOf(caller))
      // Each names a board's URL and tails: all of them only for `manage` in every channel, the caller's own for anyone.
      const all = await registry.list()
      return { watchers: principal.access.everywhere('manage') ? all : all.filter((found) => found.owner === principal.id) }
    },
    async register(caller, body) {
      const { principal } = (await identityOf(caller))
      // A registered watcher sees only what its registrant may read.
      if (!principal.access.anywhere('read'))
        throw forbidden("this token can't read anywhere, so a watcher it registers would see nothing")
      for (const [id, spec] of Object.entries(body.watch)) {
        const name = RemoteWatcherId.safeParse(id)
        if (!name.success) throw badRequest(`watch ${id}: ${name.error.issues[0]!.message}`, 'bad_watcher')
        try {
          compileWatcher(id, spec)
        } catch (error) {
          throw badRequest((error as Error).message, 'bad_watcher')
        }
      }
      return registry.register(storedPrincipal(principal), { url: body.url ?? null, watch: body.watch, sync: body.sync ?? [] })
    },
    async matches(caller, query, signal) {
      const { principal } = (await identityOf(caller))
      if (!(await registry.state()).byOwner[principal.id]) throw notFound('this token has no watchers registered here', 'no_registration')
      const queue = queueOf(principal.id) as unknown as QueueSession
      const pulling = { access: principal.access, limit: query.limit ?? 10, timers: options.scheduler !== undefined }
      const deadline = Date.now() + (query.wait ?? 0) * 1000
      for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
        const matches = await pull(queue, { ...pulling, now: Date.now() })
        if (matches.length > 0 || Date.now() >= deadline || signal.aborted) return { matches }
        await new Promise((resolve) => setTimeout(resolve, Math.min(pause, Math.max(0, deadline - Date.now()))))
      }
    },
    async ack(caller, { id, ...body }) {
      const { principal } = (await identityOf(caller))
      const result = await ack(queueOf(principal.id) as unknown as QueueSession, id, body, { now: Date.now(), timers: options.scheduler !== undefined })
      if (result === 'gone') throw notFound(`no match ${id} is waiting for this token`, 'no_match')
      if (result === 'stale') throw new HttpError(409, 'stale_lease', 'that lease ran out, and the match was pulled again')
      return { ok: true }
    },
    async events(caller, query, signal) {
      const { principal, actor } = (await identityOf(caller))
      const after = query.after !== undefined ? cursorAt(query.after) : undefined
      const { state: actors } = await session.state(actorsReducer)
      const feed = { session, reads, after, filters: query, all: query.all ?? false, me: actor.id, actors, access: principal.access }
      const { events, cursor } = await pollFeed(feed, (query.wait ?? 0) * 1000, signal)
      return { events, cursor: ref(cursor) }
    },

    // Sync's records. A caller with `sync` in a channel speaks for platform users there.

    async syncImport(caller, body) {
      const { principal } = (await needSync(caller, 'import'))
      // Only a platform user it syncs, never anyone this board signs in.
      await speaksFor(caller, principal.id, body.author, body.op === 'seen' ? null : body.from)
      if (body.op === 'seen') {
        const { state: actors } = await session.state(actorsReducer)
        const seen = actorSeen(externalIdentity(body.author).actor, actors)
        if (seen) await session.append(seen)
        return { message: null }
      }
      const author = externalIdentity(body.author)
      const may = (channel: string) => principal.access.can('sync', channel)
      if (body.op === 'post') {
        if ((body.channel === undefined) === (body.re === undefined)) throw badRequest('an import needs `channel`; a reply needs `re`')
        let re: number | undefined
        let channel = body.channel
        if (body.re !== undefined) {
          re = messageAt(body.re)
          const root = await reads.message(re)
          if (!root || !principal.access.readable(root.channel)) throw notFound(`message not found: #${body.re}`, 'message_not_found')
          channel = root.channel
        }
        if (!may(channel!)) throw forbidden(`this token can't sync in ${channel}, so it can't import there`)
        const proofs = await trusted.post(writes, { channel: body.channel, re, labels: body.labels })
        const id = body.id === undefined ? undefined : importId(caller, principal.id, body.id)
        const posted = await writePost(writes, {
          identity: author,
          proofs,
          channel: body.channel,
          re,
          text: body.text,
          labels: body.labels,
          noSync: body.noSync,
          id,
          origin: body.origin,
          from: body.from,
          lenientMentions: true,
          attachments: await attachmentsFor(principal, body.attachments),
          links: linksOf(body.links),
          config: caller.origin.config,
        })
        return { message: posted.id }
      }
      // The message it changes: found from its platform IDs, or named by its board ID. One the caller
      // can't sync is as good as missing.
      if ((body.origin === undefined) === (body.message === undefined)) throw badRequest('a change names its message by `origin` or by `message`, one or the other')
      const id = body.origin !== undefined ? await locate(body.origin) : indexOf(body.message!)
      const found = id === null || id === 0 ? null : await reads.message(id)
      if (!found || !may(found.channel)) return { message: null }
      const authorized = <P extends Permission>(permission: P) => trusted.message(writes, permission, found.id)
      // A platform's own edit or delete is what the platform did; one named by board ID is the author's, only of their own.
      const asAuthor = body.origin === undefined
      if (body.op === 'edit') await writeEdit(writes, { identity: author, authorized: await authorized('post'), text: body.text, from: body.from, asAuthor })
      else if (body.op === 'delete') await writeDelete(writes, { identity: author, authorized: await authorized('post'), from: body.from, asAuthor })
      else if (body.op === 'react')
        await writeReaction(writes, { identity: author, authorized: await authorized('react'), emoji: body.emoji, remove: body.remove ?? false, from: body.from })
      else if (body.op === 'labels') await writeLabels(writes, { identity: author, authorized: await authorized('label'), set: body.set, unset: body.unset })
      else await writeLinks(writes, { identity: author, authorized: await authorized('post'), links: linksOf(body.links) ?? [], from: body.from })
      return { message: ref(found.id) }
    },

    async syncReceipt(caller, body) {
      // A message the caller can't read is missing; one it can, but can't sync, is a 403.
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'sync', messageAt(body.message))
      const { message } = authorized
      if (body.kind === 'thread')
        return { ok: true, ...(await writeAttach(writes, { identity, authorized, target: { target: body.target, kind: body.targetKind }, cause: body.cause })) }
      const about = { id: message.id, thread: message.thread, target: body.target }
      if (body.kind === 'message')
        await receipt(caller, `receipt:${message.id}:${body.target}`, [
          { type: 'message.synced', payload: { ...about, external: body.external } },
          ...(body.files !== undefined ? [{ type: 'message.files_synced' as const, payload: { ...about, files: body.files } }] : []),
        ])
      else if (body.kind === 'files') await receipt(caller, `files:${message.id}:${body.target}`, [{ type: 'message.files_synced', payload: { ...about, files: body.files } }])
      else await receipt(caller, `failed:${message.id}:${body.target}`, [{ type: 'message.sync_failed', payload: { ...about, error: body.error } }])
      return { ok: true }
    },

    async syncThread(caller, { thread }) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      await reads.ensure()
      const synced = await store.tables.syncOf(thread)
      if (!synced || !principal.access.can('sync', synced.channel)) throw notFound(`no thread ${thread} on this board`, 'thread_not_found')
      return { thread, root: ref(synced.root), channel: synced.channel, targets: [...synced.targets], external: { ...synced.external } }
    },

    async syncFind(caller, query, signal) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      const { tables } = store
      let thread: string | null = null
      let message: string | null = null
      let holder: string | null = null
      if (query.code !== undefined) {
        // Whose a live code is, for a sign-in that carries it through an entry the caller syncs.
        const issued = (await codes.state(identityCodesReducer)).state[hashCode(query.code)]
        const keys = new Set((await entriesOf(caller, principal.id)).map((entry) => entry.key))
        if (issued && issued.usedBy === null && Date.parse(issued.expiresAt) >= Date.now() && keys.has(issued.sync)) holder = issued.principal
      }
      if (query.post !== undefined) {
        // An import the caller's sync made: a retry's, found before it goes through the middleware again.
        const landed = await reads.byEventId(importId(caller, principal.id, query.post), signal)
        if (landed && principal.access.can('sync', landed.channel)) message = ref(landed.id)
      }
      if (query.thread !== undefined) {
        // A thread synced just now may not be in the tables yet: a miss waits for them.
        let key = query.message === undefined ? await tables.threadOf(query.thread) : null
        if (key === null) {
          await reads.ensure(undefined, signal)
          key = await tables.threadOf(query.thread)
        }
        const synced = key === null ? null : await tables.syncOf(key)
        if (synced && principal.access.can('sync', synced.channel)) thread = key
        if (query.message !== undefined) {
          const id = await tables.messageOf(query.thread, query.message)
          const found = id === null ? null : await tables.message(id)
          if (found && principal.access.can('sync', found.channel)) message = ref(found.id)
        }
      }
      const { state: actors } = query.account !== undefined || query.person !== undefined ? await session.state(actorsReducer) : { state: null }
      const link = query.account !== undefined ? actors?.links[query.account] : undefined
      return {
        thread,
        message,
        person: link ? { id: link.to, method: link.method } : null,
        accounts: query.person === undefined || !actors ? [] : linkedTo(actors, query.person).map((id) => ({ id, method: actors.links[id]!.method })),
        holder,
      }
    },

    async syncCopies(caller, query) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      await reads.ensure()
      const ids = [...new Set(query.message.map(indexOf).filter((id) => id !== null && id > 0))] as number[]
      // Only the messages the caller may sync, which for one that syncs everywhere is all of them.
      const everywhere = principal.access.everywhere('sync')
      const [copies, messages] = await Promise.all([
        store.tables.copiesOf(ids),
        everywhere ? null : store.tables.messagesAt(ids, await store.tables.position()),
      ])
      const out: Record<string, Record<string, ExternalCopy>> = {}
      for (const id of ids) {
        const found = messages?.get(id)
        if (everywhere || (found && principal.access.can('sync', found.channel))) out[ref(id)] = { ...(copies.get(id) ?? {}) }
      }
      return { copies: out }
    },

    async syncRoots(caller, { by, since }) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      await reads.ensure()
      const roots = (await store.tables.recentRoots(by, since)).filter((root) => principal.access.can('sync', root.channel))
      const { state: actors } = await session.state(actorsReducer)
      const reader = await reads.reader(principal.access, roots)
      return { roots: roots.map((root) => view(root, actors, reader)) }
    },

    async inboxPush(caller, { key, events }) {
      const { principal } = (await needSync(caller, 'push to an inbox'))
      for (const { event } of events)
        for (const location of [event.channel, event.thread, 'subthread' in event ? event.subthread : null])
          if (location !== null && !location.startsWith(`${key}:`)) throw badRequest(`an inbox's platform locations belong to its sync key: ${location} isn't ${key}'s`)
      if (ownSync(caller)) {
        // This board's own sync: each platform channel's inbox, delivered here on its threads' lanes.
        for (const { id, event, raw } of events) {
          await openInbox(event.channel)
          await inboxServer.session(inboxSession(event.channel)).append({
            type: 'external.received',
            id: await idempotentId('vboard-inbox', key, id),
            payload: { sync: key, event, raw },
          })
        }
        return { ok: true }
      }
      // A sync elsewhere: its own queue, for it to pull back.
      const queue = queueOf(principal.id)
      const matched = await Promise.all(
        events.map(async ({ id, event, raw }) => ({
          type: 'watch.matched' as const,
          id: await idempotentId('vboard-inbox', key, id),
          payload: { thread: event.thread, inbox: key, event: { sync: key, event, raw } },
        })),
      )
      await queue.append(...matched).catch(async (error: unknown) => {
        if (!duplicate(error)) throw error
        for (const one of matched) await queue.append(one)
      })
      return { ok: true }
    },

    async inboxNext(caller, { key, limit }) {
      // This board's own sync gets its inbox delivered here.
      if (ownSync(caller)) return { items: [] }
      const { principal } = (await needSync(caller, 'pull from an inbox'))
      const leased = await pullInbox(queueOf(principal.id) as unknown as QueueSession, key, { access: principal.access, limit: limit ?? 10, now: Date.now(), timers: options.scheduler !== undefined })
      return {
        items: leased.map(({ id, thread, lease, attempt, event }) => {
          const item = event as { event: PlatformEvent; raw: unknown }
          return { id, key, thread, lease, attempt, event: item.event, raw: item.raw }
        }),
      }
    },

    async inboxAck(caller, { id, lease, error }) {
      const { principal } = (await needSync(caller, 'ack an inbox event'))
      const result = await ack(queueOf(principal.id) as unknown as QueueSession, id, { lease, error }, { now: Date.now(), timers: options.scheduler !== undefined })
      if (result === 'gone') throw notFound(`no inbox event ${id} is waiting for this token`, 'no_item')
      if (result === 'stale') throw new HttpError(409, 'stale_lease', 'that lease ran out, and the event was pulled again')
      return { ok: true }
    },

    async inbox(caller, { key, channel, limit }) {
      // Raw platform payloads. This board's own inbox, and every sync's that registered here, span every
      // channel; a caller's own pushes are its own.
      const { principal } = (await needSync(caller, 'read an inbox'))
      const everywhere = principal.access.everywhere('sync')
      const entries: InboxEntry[] = []
      if (everywhere) {
        const channels = channel !== undefined ? [channel] : Object.keys((await inboxes.state(inboxesReducer)).state).filter((found) => found.startsWith(`${key}:`))
        for (const found of channels)
          for (const event of await inboxServer.session(inboxSession(found)).history())
            if (event.type === 'external.received' && event.payload.sync === key)
              entries.push({ id: event.id, channel: found, createdAt: new Date(event.createdAt).toISOString(), ...event.payload } as InboxEntry)
      }
      const pushers = new Set([principal.id, ...(everywhere ? Object.keys((await registry.state()).byOwner) : [])])
      for (const pusher of pushers)
        for (const event of await queueOf(pusher).history()) {
          const pushed = event.payload as { inbox?: string; event?: { sync: string; event: PlatformEvent; raw: unknown } }
          if (event.type !== 'watch.matched' || pushed.inbox !== key || !pushed.event) continue
          if (channel !== undefined && pushed.event.event.channel !== channel) continue
          entries.push({ id: event.id, channel: pushed.event.event.channel, createdAt: new Date(event.createdAt).toISOString(), ...pushed.event } as InboxEntry)
        }
      return { events: entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit ?? 50) }
    },

    async syncCode(caller, { sync }) {
      // A person's own, for themselves: no one gets a code for someone else.
      const identity = await identityOf(caller)
      if (identity.principal.kind !== 'person') throw forbidden('only people link platform accounts')
      const entry = (await linkable()).find((candidate) => candidate.key === sync)
      if (!entry) throw notFound(`no sync entry named ${sync}`)
      const principal = identity.principal.id
      const code = newCode()
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()
      await codes.append({ type: 'identity.code_issued', payload: { hash: hashCode(code), principal, sync, expiresAt } })
      // An entry that signs people in does it where its sync runs, which redeems the code the sign-in carries.
      const signIn = entry.signIn && entry.url !== null ? `${entry.url}/identity/sign-in?${new URLSearchParams({ sync, code })}` : null
      return { code, expiresAt, ...(signIn ? { signIn } : {}) }
    },

    async syncAccount(caller, body) {
      const { principal } = await needSync(caller, 'link accounts')
      const { account } = body
      // A platform user of the entry the code was issued for, which the caller syncs.
      await speaksFor(caller, principal.id, account, body.sync)
      const hash = hashCode(body.code)
      const issued = (await codes.state(identityCodesReducer)).state[hash]
      const bad = () => notFound("that code isn't live: it expired, was used, or was issued for another sync entry", 'bad_code')
      if (!issued || issued.sync !== body.sync) throw bad()
      // A used code claims again only for a retry of the message that used it.
      const usedHere = (used: IdentityCode | undefined) => used?.usedBy === account.id && used.usedIn === (body.message ?? null)
      if (issued.usedBy === null ? Date.parse(issued.expiresAt) < Date.now() : !usedHere(issued)) throw bad()
      await codes.append({ type: 'identity.code_used', id: `used:${hash}`, payload: { hash, actor: account.id, ...(body.message !== undefined ? { message: body.message } : {}) } })
      // Two posts of it at once: the one the log took first wins.
      if (!usedHere((await codes.state(identityCodesReducer)).state[hash])) throw bad()
      return { person: issued.principal, link: await link(account, issued.principal, body.method ?? 'code', externalIdentity(account).author, `link:${hash}`) }
    },

    async syncUnlink(caller, { account }) {
      const { principal, author } = (await identityOf(caller))
      const { state } = await session.state(actorsReducer)
      const found = state.links[account]
      // Your own account, or anyone's for a caller that speaks for platform users.
      if (!found || (found.to !== principal.id && !principal.access.anywhere('sync'))) throw notFound(`${account} isn't linked`, 'not_linked')
      await session.append({ type: 'actor.unlinked', payload: { actor: account, by: author } })
      return { ok: true }
    },
  }

  /**
   * An import's client ID as the board keeps it. A sync elsewhere names its posts under its own
   * principal, so it can't take an ID anyone else would use.
   */
  function importId(caller: Caller, principal: string, id: string) {
    return ownSync(caller) ? id : `sync:${principal}:${createHash('sha256').update(`vboard-sync\u001f${id}`).digest('hex').slice(0, 32)}`
  }

  /** The sync entries a caller imports through: this board's own sync's, or what a sync elsewhere registered. */
  async function entriesOf(caller: Caller, principal: string): Promise<readonly SyncEntrySpec[]> {
    if (ownSync(caller)) return binding.sync
    return (await registry.state()).byOwner[principal]?.sync ?? []
  }

  /**
   * The sync entries this board links accounts on: its own sync's, then those of every sync
   * registered here, by key, each with the URL where its sync runs, once that's known.
   */
  async function linkable(): Promise<(SyncEntrySpec & { url: string | null })[]> {
    const found = new Map<string, SyncEntrySpec & { url: string | null }>()
    for (const entry of binding.sync) found.set(entry.key, { ...entry, url: binding.url() })
    for (const registration of Object.values((await registry.state()).byOwner))
      for (const entry of registration.sync) if (!found.has(entry.key)) found.set(entry.key, { ...entry, url: registration.url })
    return [...found.values()]
  }

  /**
   * Whether a caller may write as, or link, `author`: a platform user, never anyone this board
   * signs in, on a platform it syncs: the one of entry `from`, when it names one.
   */
  async function speaksFor(caller: Caller, principal: string, author: { id: string }, from: string | null) {
    if (authenticates(author.id)) throw forbidden(`${author.id} is someone this board signs in, not a platform user: sync can't write as them`)
    const entries = await entriesOf(caller, principal)
    const platforms = (from === null ? entries : entries.filter((entry) => entry.key === from)).map((entry) => entry.platform)
    if (from !== null && platforms.length === 0) throw forbidden(`this token doesn't sync ${from} here: its board registers its sync entries`)
    if (!platforms.some((platform) => author.id.startsWith(`${platform}:`)))
      throw forbidden(`${author.id} isn't a user of ${platforms.length ? platforms.join(' or ') : 'a platform this token syncs'}`)
  }

  /** The caller, when it may sync somewhere: what every sync route needs. */
  async function needSync(caller: Caller, what: string): Promise<Identity> {
    const identity = await identityOf(caller)
    if (!identity.principal.access.anywhere('sync')) throw forbidden(`this token can't ${what}: it needs sync`)
    return identity
  }

  /** The board message an import changes: a platform message, or the root of the thread a platform thread belongs to. */
  async function locate(origin: { thread: string; message?: string | undefined }): Promise<number | null> {
    await reads.ensure()
    if (origin.message !== undefined) return store.tables.messageOf(origin.thread, origin.message)
    const thread = await store.tables.threadOf(origin.thread)
    return thread === null ? null : ((await store.tables.syncOf(thread))?.root ?? null)
  }

  /** An import's links, with the board messages they name as log indexes. */
  const linksOf = (links: readonly (Omit<Link, 'message'> & { message: string | null })[] | undefined): Link[] | undefined =>
    links?.map((link) => ({ ...link, message: link.message === null ? null : indexOf(link.message) }))

  /**
   * A receipt. This board's own sync, while it delivers here, appends it as its consumer, keyed by
   * `key`: a retry after a crash lands it once, and an attempt that was taken over can't. Anyone
   * else's lands once by `key`.
   */
  async function receipt(caller: Caller, key: string, events: { type: 'message.synced' | 'message.files_synced' | 'message.sync_failed'; payload: unknown }[]) {
    const ctx = delivering.getStore()
    if (ctx && ownSync(caller)) {
      await ctx.session.append(key, ...(events as never[]))
      return
    }
    for (const [i, event] of events.entries())
      await session.append({ ...event, id: await idempotentId('vboard-receipt', key, String(i)) } as never).catch((error: unknown) => {
        if (!duplicate(error)) throw error
      })
  }

  /** Records that the inbox for `channel` exists, the first time anything lands in it. */
  async function openInbox(channel: string) {
    if (opened.has(channel)) return
    if (!(await inboxes.state(inboxesReducer)).state[channel])
      await inboxes.append({ type: 'inbox.opened', id: await idempotentId('vboard-inbox', 'opened', channel), payload: { channel } })
    opened.add(channel)
  }

  /** Records that `account` is `to`, unless it already is. `id` makes a retry a no-op. */
  async function link(account: ExternalAuthor, to: string, method: 'code' | 'consent', by: Author, id?: string): Promise<LinkedAccount> {
    const { state: actors } = await session.state(actorsReducer)
    const seen = actorSeen({ id: account.id, kind: 'external', handle: account.handle, name: account.name, avatar: account.avatar }, actors)
    const existing = actors.links[account.id]
    // A code is news even for an account already linked (`id` keeps its retries single); a sign-in check isn't.
    if (existing?.to === to && !id) {
      if (seen) await session.append(seen)
      return { actor: account.id, handle: account.handle, name: account.name, method: existing.method, at: existing.at }
    }
    await session.append(
      ...(seen ? [{ ...seen, ...(id ? { id: `${id}:seen` } : {}) }] : []),
      { type: 'actor.linked' as const, ...(id ? { id } : {}), payload: { actor: account.id, to, method, by } },
    )
    return { actor: account.id, handle: account.handle, name: account.name, method, at: new Date().toISOString() }
  }

  // The inbox's second and the watchers' last, where tests and tools look for them. The identity
  // session has no consumers or timers.
  const servers = [server, inboxServer, schedules.server, registry.server, watchers.server]
  return {
    methods,
    schedules,
    /** The scheduler's callback, for every A2 server behind the board. */
    scheduler: options.scheduler
      ? options.scheduler.handler(...servers)
      : async (_request: Request) => toErrorResponse(notFound('this board has no scheduler')),
    servers,
    session,
    store,
  }
}

/**
 * The board in this deployment, on A2's log: its store, scheduler, sync, middleware, and
 * attachments. It's the backend itself: pass it to `board({ backend })`, and mount its
 * `scheduler` in a route of its own. Nothing is built or connected until board() binds it.
 */
export function a2(given: A2Options = {}) {
  const { options, missing } = complete(given)
  let built: ReturnType<typeof build> | null = null
  const ready = () => {
    // Said to every caller, so the CLI shows it: a board that can't do its whole job doesn't half-serve.
    if (missing) throw new HttpError(500, 'not_configured', missing)
    if (!built) throw new Error("a2: this backend isn't serving a board yet: pass it to board({ backend })")
    // The first call on an instance starts the schedules catching up, and doesn't wait.
    built.schedules.catchUp()
    return built
  }
  const methods = Object.fromEntries(
    METHODS.map((name) => [name, (caller: Caller, input: never, signal: AbortSignal) => (ready().methods[name] as (...args: unknown[]) => unknown)(caller, input, signal)]),
  ) as unknown as ProtocolMethods
  const backend = {
    ...methods,
    // The issuers its `oidc()` rules name: board() verifies their tokens for it.
    issuers: typeof options.access === 'function' ? [] : issuersOf(options.access ?? []),
    // Everything it answers is the protocol's.
    routes: [] as BackendRoute[],
    bind(binding: BoardBinding) {
      if (built) throw new Error('a2: this backend already serves a board: create one a2() per board()')
      // Missing a piece, it builds nothing: A2 refuses a server without a store in production,
      // and the first call says what's missing instead.
      if (!missing) built = build(options, binding)
    },
    /** The scheduler's callback: `export { scheduler as POST }` from a route of its own. A board without a scheduler answers 404. */
    scheduler: (request: Request): Promise<Response> => ready().scheduler(request),
    /** The A2 servers behind this board, to share one scheduler with other A2 servers. */
    get servers() {
      // A board missing a piece in production built none, and a route that loads them (to share
      // its scheduler, say) must still load, at build time too. Its requests say what's missing.
      return missing ? [] : ready().servers
    },
    /** For tests and tools. */
    get session() {
      return ready().session
    },
    get store() {
      return ready().store
    },
  }
  // What tests and tools look at stays out of a spread, so `{ ...a2(), delete }` is a backend too.
  for (const key of ['servers', 'session', 'store']) Object.defineProperty(backend, key, { enumerable: false })
  return backend satisfies Backend
}

export type A2Backend = ReturnType<typeof a2>
