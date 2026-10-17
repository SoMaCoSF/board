import { z } from 'zod'
import { idempotentId } from 'experimental-a2'
import { createServer, type A2Scheduler } from 'experimental-a2/server'
import { boardContract, BOARD_SESSION, inboxSession, SCHEDULES_SESSION, type BoardEvents } from '../contract/contract.ts'
import { actorsReducer, channelsReducer, linkedTo, syncReducer } from '../contract/reducers.ts'
import { ATTACHMENT_BYTES_MAX, RemoteWatcherId } from '../contract/schemas.ts'
import {
  EditBody,
  EventsQuery,
  IdentityCheckBody,
  IdentityLinkBody,
  IdentityUnlinkBody,
  InboxQuery,
  SourceReadQuery,
  LabelBody,
  MessagesQuery,
  ThreadsQuery,
  PostBody,
  ReactBody,
  RedriveBody,
  RegisterBody,
  routes,
  ScheduleBody,
  SchedulesQuery,
  SyncBody,
  TypingBody,
  type Discovery,
  type IdentityView,
  type StuckEvent,
  type TypingResult,
  type Me,
  type RouteName,
} from '../api/routes.ts'
import { createBoardClient, type BoardClient } from '../client/client.ts'
import { createSyncEngine } from '../sync/engine.ts'
import type { SyncProvider } from '../sync/provider.ts'
import { VERSION } from '../version.ts'
import {
  allows,
  createVerifier,
  type AuthOptions,
  type Capability,
  type Principal,
  type TrustedSource,
} from './auth.ts'
import { KNOWN_AGENTS, resolveActor } from './actors.ts'
import { avatarSvg } from './avatars.ts'
import { attachmentResponse, defaultBlob, readAttachment, writeUpload, type BlobStore } from './blob.ts'
import { badRequest, forbidden, HttpError, json, notFound, toErrorResponse, unauthorized } from './errors.ts'
import { liveFeed, personView, pollFeed, toMessageFilter, view } from './feed.ts'
import { discoveryIdentity, ownProjectId, ownTeamId } from './identity.ts'
import { createReads, tablesConsumer } from './reads.ts'
import { createSchedules } from './schedules.ts'
import { defaultStore } from '../store/default.ts'
import { TABLES_CONSUMER } from '../store/sql.ts'
import type { BoardStore } from '../store/types.ts'
import { compileWatcher, createWatchers, ID, type Match as WatchMatch, type Watcher } from './watch.ts'
import { createRegistry, type Registration } from './registry.ts'
import { remoteBoard } from './remote.ts'
import { transport, type Transport } from './transport.ts'
import {
  writeAttach,
  writeDelete,
  writeEdit,
  writeLabels,
  writePost,
  writeReaction,
  deploymentIdentity,
  type Identity,
  type WriteContext,
  type WriteOrigin,
} from './writes.ts'
import { MIDDLEWARE_ACTOR, type Middleware } from './middleware.ts'
import { queryObject, readJson, route } from './routing.ts'

export type BoardOptions = {
  /**
   * Where the board keeps its log and tables: `postgres()`, `sqlite()`, or `memory()` from
   * `vboard/store-*`. Omitted: SQLite in development, memory in tests, an error in production.
   */
  store?: BoardStore
  /** Required for sync in production, and for scheduled messages. Mount the board's `scheduler` as `POST` in its own route. */
  scheduler?: A2Scheduler
  /** Machines outside this project that may call the board. */
  trustedSources?: readonly TrustedSource[]
  /** Two-way sync, keyed by a name you choose: `{ slack: slack({...}), github: github({...}) }`. */
  sync?: Record<string, SyncProvider>
  /**
   * Runs on every post and edit before it lands, whatever it came from: the API, sync,
   * watchers, schedules. Each calls `next()` to pass the write on; one that doesn't drops it.
   */
  middleware?: readonly Middleware[]
  /** Tails the board runs for you, keyed by an id you choose: `{ triage: { tail: 'firehose', run } }`. */
  watch?: Record<string, Watcher>
  /** The board's Vercel project. Defaults to `VERCEL_PROJECT_ID` or `.vercel/project.json`. */
  project?: { id: string; teamId?: string }
  /** The board's public URL, which every token's audience must equal. Inferred from requests otherwise. */
  url?: string
  /** The mount path, e.g. `/api/board`. Inferred from requests otherwise. */
  basePath?: string
  /** Test issuers. Production uses Vercel's and GitHub's. */
  auth?: AuthOptions
  /** SSE streams close after this long, before the platform's limit; clients reconnect. */
  streamMaxMs?: number
  /**
   * Where attachments live: `vercelBlob()` from `vboard/adapter-vercel-blob`. Omitted: memory
   * in tests, `.a2/attachments` in development, and no uploads in production.
   */
  blob?: BlobStore
  /**
   * The board that keeps this one's log, e.g. `https://board.example.com/api/board`. A board
   * with a remote keeps none: it reads and writes the remote, which runs its watchers' tails
   * and delivers what matches to it.
   */
  remote?: string
  /** For tests: how the board reaches other boards. Defaults to `fetch` and the deployment's OIDC token. */
  transport?: Partial<Transport>
}

const boardServer = (options: BoardOptions) =>
  createServer({
    contract: boardContract,
    ...(options.store?.log ? { store: options.store.log } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })

export type BoardSession = ReturnType<ReturnType<typeof boardServer>['session']>

/** What `vb stuck` needs of an A2 session, whatever its contract. */
type Redrivable = {
  deadLetters(): Promise<
    {
      consumer: string
      index: number
      type: string
      lane: string | null
      attemptCount: number
      failureCount: number
      lastError: string | null
      failedAt: Date
    }[]
  >
  redrive(target: { consumer: string; index: number }, options: { action: 'retry' | 'skip' }): Promise<{ redriven: boolean }>
}

const MIDDLEWARE_IDENTITY = deploymentIdentity(MIDDLEWARE_ACTOR, 'middleware')

/**
 * `idempotentId`'s shape, a UUIDv8: the IDs the board derives for its own writes (schedule
 * sends, watchers, sync). They're guessable, so an API caller can't post with one and take it first.
 */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const tooLarge = () => new HttpError(413, 'too_large', `attachments are at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`)

/** The body, refused as soon as it's past `max`: with or without a `content-length`, it never reads more. */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > max) throw tooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > max) throw tooLarge()
    chunks.push(chunk)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/**
 * Mounts a board: one log in one route, or with a `remote`, a route that keeps none and uses
 * the remote's. Create it once, at module scope.
 */
export function board(options: BoardOptions & { remote: string }): ReturnType<typeof remoteBoard>
export function board(options?: BoardOptions & { remote?: undefined }): ReturnType<typeof logBoard>
export function board(options?: BoardOptions): ReturnType<typeof logBoard> | ReturnType<typeof remoteBoard>
export function board(options: BoardOptions = {}) {
  return options.remote !== undefined ? remoteBoard({ ...options, remote: options.remote }) : logBoard(options)
}

function logBoard(options: BoardOptions) {
  const blob = options.blob ?? defaultBlob()
  const store = options.store ?? defaultStore()
  // The same A2 store object for every server: A2 recognizes its own stores by identity.
  const log = store.log
  const engine =
    options.sync && Object.keys(options.sync).length > 0
      ? createSyncEngine({ entries: options.sync, store: log, scheduler: options.scheduler, blob })
      : null
  const net = transport(options.transport)
  const registry = createRegistry({ store: log, scheduler: options.scheduler })
  // Always, since boards with this one as their remote may register watchers at any time.
  const watchers = createWatchers({
    watch: options.watch ?? {},
    store: log,
    scheduler: options.scheduler,
    registered: { state: registry.state, deliver },
  })
  const schedules = createSchedules({ store: log, scheduler: options.scheduler })
  const projection = tablesConsumer(store.tables)
  // The tables, watchers, and sync each keep their own place in the board's log.
  const consumers = [projection, watchers.boardConsumer, engine?.outbound].filter((consumer) => consumer !== undefined)
  const server = createServer({
    contract: boardContract,
    ...(log ? { store: log } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers,
  })
  const session = server.session(BOARD_SESSION)
  const reads = createReads(store.tables, session, projection)
  const writes: WriteContext = {
    session,
    reads,
    configTargets: engine ? engine.configTargets : async () => [],
    ...(engine ? { findByEmail: engine.findByEmail } : {}),
    normalizeTarget: engine
      ? engine.normalizeTarget
      : async () => {
          throw badRequest('this board has no sync configured')
        },
    middleware: options.middleware ?? [],
    middlewareClient: () => clientAs(MIDDLEWARE_IDENTITY, null, { via: { kind: 'middleware' } }),
  }
  const verify = createVerifier({
    projectId: () => ownProjectId(options.project),
    teamId: () => ownTeamId(options.project),
    trustedSources: options.trustedSources ?? [],
    ...(options.auth ? { auth: options.auth } : {}),
  })
  const streamMaxMs = options.streamMaxMs ?? 280_000

  async function authenticate(request: Request, boardUrl: string): Promise<Principal> {
    const header = request.headers.get('authorization') ?? ''
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) throw unauthorized('missing bearer token')
    return verify(token, boardUrl, request.headers.get('x-vercel-oidc-token') ?? undefined)
  }

  /** The sessions whose consumers run on lanes, so a dead letter there stops the rest of its lane. */
  async function lanedSessions(): Promise<{ id: string; session: Redrivable }[]> {
    const ids: [string, { session(id: string): Redrivable }][] = [
      [BOARD_SESSION, server],
      [SCHEDULES_SESSION, schedules.server],
      ...(await watchers.sessions()).map((id): [string, typeof watchers.server] => [id, watchers.server]),
      ...(engine ? (await engine.inboxChannels()).map((channel): [string, typeof engine.inboxServer] => [inboxSession(channel), engine.inboxServer]) : []),
    ]
    return ids.map(([id, owner]) => ({ id, session: owner.session(id) }))
  }

  async function stuck(): Promise<StuckEvent[]> {
    const found = (await Promise.all((await lanedSessions()).map(async ({ id, session }) => (await session.deadLetters()).map((dead) => ({ id, dead }))))).flat()
    if (found.length === 0) return []
    // The tables first: reads and writes wait on them, so they're what to retry first.
    found.sort((a, b) => Number(b.dead.consumer === TABLES_CONSUMER) - Number(a.dead.consumer === TABLES_CONSUMER))
    const { state: sync } = await session.state(syncReducer)
    // A thread's key is its root's post's event ID.
    const roots = new Map<string, number | null>()
    const rootOf = async (thread: string) => {
      if (!roots.has(thread)) roots.set(thread, (await store.tables.byEventId(thread))?.id ?? null)
      return roots.get(thread)!
    }
    return Promise.all(found.map(async ({ id, dead }) => {
      const laneThread = dead.lane?.startsWith('thread:') ? dead.lane.slice('thread:'.length) : null
      // An inbox's lanes are platform threads; everywhere else they're the board's.
      const inbox = id.startsWith('inbox:')
      const thread = inbox ? (laneThread && (sync.byExternalThread[laneThread] ?? null)) : laneThread
      return {
        session: id,
        index: dead.index,
        consumer: dead.consumer,
        type: dead.type,
        lane: dead.lane,
        thread,
        root: thread === null ? null : await rootOf(thread),
        external: inbox ? laneThread : null,
        attempts: dead.attemptCount,
        failures: dead.failureCount,
        error: dead.lastError,
        failedAt: dead.failedAt.toISOString(),
      }
    }))
  }

  async function redrive(body: z.infer<typeof RedriveBody>, by: string) {
    const target = (await lanedSessions()).find(({ id }) => id === body.session)
    if (!target) throw notFound(`no session ${body.session} on this board`)
    // Without a consumer, every consumer the event is stuck for.
    const consumers =
      body.consumer !== undefined
        ? [body.consumer]
        : (await target.session.deadLetters()).filter((dead) => dead.index === body.index).map((dead) => dead.consumer)
    const done: string[] = []
    for (const consumer of consumers) {
      const { redriven } = await target.session.redrive({ consumer, index: body.index }, { action: body.action })
      if (redriven) done.push(consumer)
    }
    if (done.length > 0)
      console.info(`[vboard] ${by} ${body.action === 'retry' ? 'retried' : 'skipped'} stuck event ${body.session}#${body.index} for ${done.join(', ')}`)
    return { redriven: done.length > 0 }
  }

  const require = (principal: Principal, capability: Capability) => {
    if (!allows(principal, capability)) throw forbidden(`this source may not ${capability}`)
  }

  /**
   * A client for inbound functions: in-process, writing as `identity`, its posts idempotent
   * per trigger. Its posts and edits reach the middleware from `origin`.
   */
  function clientAs(identity: Identity, trigger: string | null, origin: WriteOrigin): BoardClient {
    let writesMade = 0
    return createBoardClient({
      // Under the configured mount, so `route()` accepts the paths it builds.
      url: `http://in-process.board${(options.basePath ?? '').replace(/\/+$/, '')}`,
      token: 'in-process',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init)
        if (trigger !== null && request.method === 'POST' && new URL(request.url).pathname.endsWith('/messages')) {
          const body = ((await request.json()) ?? {}) as Record<string, unknown>
          body.id ??= await idempotentId('vboard-inbound', trigger, 'client', String(writesMade++))
          request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
        }
        return dispatch(request, identity, origin)
      }) as typeof fetch,
    })
  }

  engine?.bind({ session, writes, clientAs })
  schedules.bind({ writes })
  watchers.bind({ clientAs, reads })

  /** Posts one match to the board that registered its watcher. A 404 means it has no such watcher anymore. */
  async function deliver(registration: Registration, id: string, match: WatchMatch, signal: AbortSignal) {
    const token = await net.token(registration.url)
    const response = await net.fetch(`${registration.url}/deliveries/${id}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        // Deployment Protection lets it through when the board trusts this board's project.
        'x-vercel-trusted-oidc-idp-token': token,
        'x-board-watchers': registration.hash,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: match.id, event: match.payload.event }),
      // A redirect means the registered URL is wrong: say so, rather than post wherever it points.
      redirect: 'manual',
      signal,
    })
    if (response.ok || response.status === 404) return
    const text = await response.text().catch(() => '')
    let message = text.slice(0, 300)
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message
    } catch {}
    throw new Error(`${registration.url} answered ${response.status}${message ? `: ${message}` : ''}`)
  }

  async function dispatch(request: Request, injected: Identity | null, origin: WriteOrigin = { via: { kind: 'api' } }): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = route(request.method, url.pathname, options.basePath)
      if (!match) throw notFound(`no route: ${request.method} ${url.pathname}`)
      const boardUrl = (options.url ?? `${url.origin}${match.base}`).replace(/\/+$/, '')

      switch (match.name) {
        case 'discovery': {
          const identity = await discoveryIdentity(request, options.project)
          const body: Discovery = {
            version: VERSION,
            url: boardUrl,
            audience: boardUrl,
            team_id: identity.teamId,
            project_id: identity.projectId,
            sync: Object.entries(options.sync ?? {}).map(([key, entry]) => ({ key, platform: entry.platform })),
          }
          return json(body)
        }
        case 'avatar': {
          const name = match.param ?? ''
          if (!(KNOWN_AGENTS as readonly string[]).includes(name)) throw notFound(`no avatar: ${name}`)
          return new Response(avatarSvg(name), {
            headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
          })
        }
        case 'openapi':
          return json(openapi())
        case 'webhook':
          // Platforms can't send a board token: the adapter verifies the request.
          if (!engine) throw notFound('this board has no sync configured')
          return await engine.handleWebhook(match.param!, request)
      }

      const principal = injected?.principal ?? (await authenticate(request, boardUrl))
      const { author, actor } = injected ?? resolveActor(principal, request.headers, boardUrl)
      const identity: Identity = { principal, author, actor }

      switch (match.name) {
        case 'me': {
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
          }
          return json(body)
        }
        case 'channels': {
          const { state, index } = await session.state(channelsReducer)
          const channels = Object.values(state).sort((a, b) => a.path.localeCompare(b.path))
          return json({ channels, cursor: index })
        }
        case 'actors': {
          const { state, index } = await session.state(actorsReducer)
          const actors = Object.values(state.byId)
            .sort((a, b) => a.handle.localeCompare(b.handle))
            .map((a) => {
              const person = personView(state, a.id)
              return person ? { ...a, person } : a
            })
          return json({ actors, cursor: index })
        }
        case 'identity': {
          const { state, index } = await session.state(actorsReducer)
          const links = linkedTo(state, principal.id).map((id) => ({
            actor: id,
            handle: state.byId[id]?.handle ?? null,
            name: state.byId[id]?.name ?? null,
            method: state.links[id]!.method,
            at: state.links[id]!.at,
          }))
          const unlinked = Object.entries(options.sync ?? {})
            .filter(([, entry]) => !links.some((link) => link.actor.startsWith(`${entry.platform}:user:`)))
            .map(([key]) => key)
          const body: IdentityView = { principal: principal.id, links, unlinked, cursor: index }
          return json(body)
        }
        case 'identityLink': {
          if (!engine) throw notFound('this board has no sync configured')
          const body = IdentityLinkBody.parse(await readJson(request))
          return json(await engine.startLink(identity, body.sync, body.method))
        }
        case 'identityCheck': {
          if (!engine) throw notFound('this board has no sync configured')
          const body = IdentityCheckBody.parse(await readJson(request))
          return json({ linked: await engine.checkLink(identity, body.sync) })
        }
        case 'identityUnlink': {
          if (principal.kind !== 'person') throw forbidden('only people link platform accounts')
          const body = IdentityUnlinkBody.parse(await readJson(request))
          const { state } = await session.state(actorsReducer)
          const mine = linkedTo(state, principal.id)
          const wanted = body.actor.replace(/^@/, '').toLowerCase()
          const found = mine.filter((id) => id === body.actor || state.byId[id]?.handle.toLowerCase() === wanted)
          if (found.length === 0) throw notFound(`${body.actor} isn't linked to you`, 'not_linked')
          if (found.length > 1) throw badRequest(`${body.actor} names several of your accounts: use ${found.join(' or ')}`, 'ambiguous_actor')
          await session.append({ type: 'actor.unlinked', payload: { actor: found[0]!, by: author } })
          return json({ ok: true, actor: found[0]! })
        }
        case 'messages': {
          const query = MessagesQuery.parse(queryObject(url))
          const { state: actors } = await session.state(actorsReducer)
          const { messages, position } = await reads.messages(toMessageFilter(query, { me: actor.id, actors }), {
            ...(query.before !== undefined ? { before: query.before } : {}),
            ...(query.after !== undefined ? { after: query.after } : {}),
            limit: query.limit ?? 50,
          })
          return json({ messages: messages.map((m) => view(m, actors)), cursor: position })
        }
        case 'threads': {
          const query = ThreadsQuery.parse(queryObject(url))
          const { state: actors } = await session.state(actorsReducer)
          const { threads, position } = await reads.threads(toMessageFilter(query, { me: actor.id, actors }), {
            ...(query.after !== undefined ? { after: query.after } : {}),
            limit: query.limit ?? 50,
          })
          return json({
            threads: threads.map((t) => ({ message: view(t.root, actors), replies: t.replies, last: t.last && view(t.last, actors) })),
            cursor: position,
          })
        }
        case 'message': {
          const message = await reads.message(match.id!, request.signal)
          if (!message) throw notFound(`message not found: #${match.id}`, 'message_not_found')
          const [{ messages, cursor }, { state: actors }] = await Promise.all([
            reads.thread(message.re ?? message.id, request.signal),
            session.state(actorsReducer),
          ])
          const [root, ...replies] = messages
          return json({
            message: view(root!, actors),
            replies: replies.map((reply) => view(reply, actors)),
            cursor,
            schedules: await schedules.forThread(root!.id),
          })
        }
        case 'post': {
          require(principal, 'post')
          const body = PostBody.parse(await readJson(request))
          if (body.sync?.length) require(principal, 'sync')
          if (!injected && body.id !== undefined && DERIVED_ID.test(body.id))
            throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
          const attachments = await Promise.all([...new Set(body.attachments ?? [])].map((id) => readAttachment(blob, id)))
          const { unknownMentions, ...message } = await writePost(writes, {
            attachments,
            identity,
            channel: body.channel,
            re: body.re,
            text: body.text,
            labels: body.labels,
            noSync: body.noSync,
            id: body.id,
            sync: body.sync,
            ...origin,
          })
          return json({ message, ...(unknownMentions ? { unknownMentions } : {}) }, 201)
        }
        case 'schedule': {
          require(principal, 'post')
          const body = ScheduleBody.parse(await readJson(request))
          const attachments = await Promise.all([...new Set(body.attachments ?? [])].map((id) => readAttachment(blob, id)))
          return json(await schedules.create(identity, body, attachments), 201)
        }
        case 'schedules': {
          const query = SchedulesQuery.parse(queryObject(url))
          let root: number | undefined
          if (query.re !== undefined) {
            const message = await reads.message(query.re, request.signal)
            if (!message) throw notFound(`message not found: #${query.re}`, 'message_not_found')
            root = message.re ?? message.id
          }
          return json({ schedules: await schedules.list({ ...query, ...(root !== undefined ? { root } : {}) }) })
        }
        case 'cancelSchedule': {
          require(principal, 'post')
          return json(await schedules.cancel(identity, match.id!))
        }
        case 'edit': {
          require(principal, 'post')
          const body = EditBody.parse(await readJson(request))
          const { unknownMentions } = await writeEdit(writes, { identity, id: match.id!, text: body.text, ...origin })
          return json({ ok: true, ...(unknownMentions ? { unknownMentions } : {}) })
        }
        case 'delete': {
          require(principal, 'post')
          await writeDelete(writes, { identity, id: match.id! })
          return json({ ok: true })
        }
        case 'react': {
          require(principal, 'react')
          const body = ReactBody.parse(await readJson(request))
          await writeReaction(writes, { identity, id: match.id!, emoji: body.emoji, remove: body.remove })
          return json({ ok: true })
        }
        case 'label': {
          require(principal, 'label')
          const body = LabelBody.parse(await readJson(request))
          await writeLabels(writes, { identity, id: match.id!, set: body.set, unset: body.unset })
          return json({ ok: true })
        }
        case 'upload': {
          require(principal, 'post')
          const name = request.headers.get('x-board-filename')
          let decoded: string | null = null
          try {
            decoded = name === null ? null : decodeURIComponent(name)
          } catch {
            throw badRequest('`x-board-filename` is not URI-encoded')
          }
          const attachment = await writeUpload(blob, {
            data: await readCapped(request, ATTACHMENT_BYTES_MAX),
            name: decoded,
            type: request.headers.get('content-type'),
          })
          return json({ attachment }, 201)
        }
        case 'attachment':
          return await attachmentResponse(blob, match.param!)
        case 'sync': {
          require(principal, 'sync')
          const body = SyncBody.parse(await readJson(request))
          return json(await writeAttach(writes, { identity, id: match.id!, target: body.target }))
        }
        case 'typing': {
          require(principal, 'post')
          const message = await reads.message(match.id!, request.signal)
          if (!message || message.deleted) throw notFound(`message not found: #${match.id}`, 'message_not_found')
          const { status } = TypingBody.parse(await readJson(request)) ?? {}
          const body: TypingResult = { targets: engine ? await engine.typing(message.thread, status) : [] }
          return json(body)
        }
        case 'inbox': {
          // Raw platform payloads: full access only.
          if (principal.can !== 'all') throw forbidden('reading the inbox needs full access')
          if (!engine) throw notFound('this board has no sync configured')
          const query = InboxQuery.parse(queryObject(url))
          return json({ events: await engine.readInbox(match.param!, query.channel, query.limit ?? 50) })
        }
        case 'stuck': {
          // What failed, with its errors: full access only, like the inbox.
          if (principal.can !== 'all') throw forbidden('reading stuck events needs full access')
          return json({ stuck: await stuck() })
        }
        case 'redrive': {
          if (principal.can !== 'all') throw forbidden('retrying or skipping stuck events needs full access')
          return json(await redrive(RedriveBody.parse(await readJson(request)), actor.id))
        }
        case 'sourceRead': {
          // The app's token reads what the app can, not what the caller can: full access only.
          if (principal.can !== 'all') throw forbidden('reading a source needs full access')
          if (!engine) throw notFound('this board has no sync configured')
          const query = SourceReadQuery.parse(queryObject(url))
          return json(await engine.readSource(match.param!, query.target, query.limit ?? 50))
        }
        case 'watchers':
          return json({ watchers: await registry.list() })
        case 'register': {
          require(principal, 'post')
          const body = RegisterBody.parse(await readJson(request))
          for (const [id, spec] of Object.entries(body.watch)) {
            const name = RemoteWatcherId.safeParse(id)
            if (!name.success) throw badRequest(`watch ${id}: ${name.error.issues[0]!.message}`, 'bad_watcher')
            try {
              compileWatcher(id, spec)
            } catch (error) {
              throw badRequest((error as Error).message, 'bad_watcher')
            }
          }
          return json(await registry.register(principal.id, body))
        }
        case 'deliver':
          throw notFound('this board keeps its own log: deliveries go to a board with a remote')
        case 'events': {
          const query = EventsQuery.parse(queryObject(url))
          const lastEventId = Number(request.headers.get('last-event-id'))
          const after =
            query.after ?? (Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : undefined)
          const { state: actors } = await session.state(actorsReducer)
          const feedOptions = { session, reads, after, filters: query, all: query.all ?? false, me: actor.id, actors }
          if ((request.headers.get('accept') ?? '').includes('text/event-stream'))
            return sse(feedOptions, request.signal, streamMaxMs)
          return json(await pollFeed(feedOptions, (query.wait ?? 0) * 1000, request.signal))
        }
      }
      throw notFound(`no route: ${request.method} ${url.pathname}`)
    } catch (error) {
      return toErrorResponse(error)
    }
  }

  const handle = (request: Request) => dispatch(request, null)
  // The watchers' server stays last, where it's always been.
  const servers = [server, ...(engine ? [engine.inboxServer] : []), schedules.server, registry.server, watchers.server]
  return {
    GET: handle,
    POST: handle,
    fetch: handle,
    /** The scheduler's callback: `export { scheduler as POST }` from a route of its own. */
    scheduler: options.scheduler
      ? options.scheduler.handler(...servers)
      : async () => toErrorResponse(notFound('this board has no scheduler')),
    /** The A2 servers behind this board, to share one scheduler with other A2 servers. */
    servers,
    /**
     * An in-process client for your own server code, writing as `vboard:client:<name>`. With a
     * `key` (a webhook delivery's ID, say), its posts are idempotent: the same key and order
     * never post twice. Its writes wake watchers and sync like any other.
     */
    client(name: string, clientOptions: { key?: string } = {}): BoardClient {
      if (!ID.test(name)) throw new Error(`client: names use lowercase letters, numbers, - and _, got: ${name}`)
      const key = clientOptions.key === undefined ? null : `client:${name}:${clientOptions.key}`
      return clientAs(deploymentIdentity(`vboard:client:${name}`, name), key, { via: { kind: 'client', name } })
    },
    /** For tests and tools. */
    engine,
    session,
    store,
  }
}

/** Server-sent events: `id` is the log index, so `Last-Event-ID` resumes exactly. */
function sse(options: Parameters<typeof liveFeed>[0], requestSignal: AbortSignal, maxMs: number): Response {
  const encoder = new TextEncoder()
  const controller = new AbortController()
  const signal = AbortSignal.any([requestSignal, controller.signal, AbortSignal.timeout(maxMs)])
  const body = new ReadableStream<Uint8Array>({
    async start(stream) {
      const ping = setInterval(() => {
        try {
          stream.enqueue(encoder.encode(': ping\n\n'))
        } catch {}
      }, 15_000)
      try {
        stream.enqueue(encoder.encode(': connected\n\n'))
        // Filtered-out events still advance the client's cursor with a bare `id:`.
        for await (const item of liveFeed(options, signal)) {
          stream.enqueue(
            encoder.encode(
              item.view
                ? `id: ${item.index}\nevent: board\ndata: ${JSON.stringify(item.view)}\n\n`
                : `id: ${item.index}\n\n`,
            ),
          )
        }
      } catch (error) {
        console.error('[vboard] feed failed', error)
      } finally {
        clearInterval(ping)
        try {
          stream.close()
        } catch {}
      }
    },
    cancel() {
      controller.abort()
    },
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

function openapi() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [name, definition] of Object.entries(routes)) {
    const path = definition.path.replace(/:(\w+)/g, '{$1}')
    const operation: Record<string, unknown> = { operationId: name }
    if ('query' in definition) operation['x-query-schema'] = z.toJSONSchema(definition.query, { io: 'input' })
    if ('body' in definition)
      operation.requestBody = {
        content: { 'application/json': { schema: z.toJSONSchema(definition.body, { io: 'input' }) } },
      }
    ;(paths[path] ??= {})[definition.method.toLowerCase()] = operation
  }
  return { openapi: '3.1.0', info: { title: 'vboard', version: VERSION }, paths }
}
