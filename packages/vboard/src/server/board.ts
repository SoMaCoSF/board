import { idempotentId } from 'experimental-a2'
import {
  AckBody,
  EditBody,
  EventsQuery,
  IdentityCheckBody,
  IdentityLinkBody,
  IdentityUnlinkBody,
  InboxAckBody,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LabelBody,
  MatchesQuery,
  MessagesQuery,
  PostBody,
  ReactBody,
  Ref,
  RegisterBody,
  ScheduleBody,
  SchedulesQuery,
  SignInQuery,
  SourceReadQuery,
  SyncAccountBody,
  SyncBody,
  SyncCodeBody,
  SyncCopiesQuery,
  SyncFindQuery,
  SyncImportBody,
  SyncReceiptBody,
  SyncRootsQuery,
  SyncUnlinkBody,
  ThreadsQuery,
  TypingBody,
  type Discovery,
  type MessageView,
  type RegistrationView,
} from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import { createBoardClient, type BoardClient } from '../client/client.ts'
import type { Actor } from '../contract/reducers.ts'
import type { ExternalAuthor } from '../contract/contract.ts'
import { ATTACHMENT_BYTES_MAX, type Attachment } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import { createSyncEngine, type SyncEngine, type SyncEvent } from '../sync/engine.ts'
import type { SyncProvider } from '../sync/provider.ts'
import { SYNC, type Backend, type BoardBinding, type Caller, type Subscription, type SyncEntry } from './backend.ts'
import { createVerifier, hostPrincipal, type Authenticate, type AuthOptions, type Principal } from './auth.ts'
import { compileAccess, parseScope, type Access } from './access.ts'
import { externalActor, KNOWN_AGENTS, resolveActor } from './actors.ts'
import { avatarSvg } from './avatars.ts'
import { badRequest, forbidden, HttpError, json, notFound, toErrorResponse, unauthorized } from './errors.ts'
import { discoveryIdentity, ownProjectId, ownTeamId } from './identity.ts'
import { runMiddleware, type Middleware, type Write, type WriteSource } from './middleware.ts'
import { createRouter, openapi, queryObject, readCapped, readJson, type BoardRoute } from './routing.ts'
import { syncTarget, withEmailMentions, type SyncTarget, type WriteOrigin } from './writes.ts'
import type { Watcher } from './watch.ts'

/** `board()`'s options: where the board lives, who may use it, and the watchers that run here. */
export type BoardOptions = {
  /** Where the board lives: `a2({ … })` from `vboard/backend-a2`, `http(url)` from `vboard/backend-http`, or your own. */
  backend: Backend
  /** Tails the board runs for you, keyed by an id you choose: `{ triage: { tail: 'firehose', run } }`. */
  watch?: Record<string, Watcher>
  /** The board's public URL, which every token's audience must equal. Inferred from requests otherwise. */
  url?: string
  /** The mount path, e.g. `/api/board`. Inferred from requests otherwise. */
  basePath?: string
  /**
   * A host's own verifier, for a host serving many teams' boards: `(request) => ({ id, kind, handle })`,
   * who the request is in the board's ID scheme. It replaces the built-in one, so no token's audience
   * or the board's own project counts then. To reject, return or throw a `Response`. What a principal
   * may do is the backend's: `a2({ access })`'s function.
   */
  authenticate?: Authenticate
  /** The board's Vercel project. Defaults to `VERCEL_PROJECT_ID` or `.vercel/project.json`. */
  project?: { id: string; teamId?: string }
  /** Test issuers. Production uses Vercel's and GitHub's. */
  auth?: AuthOptions
  /** SSE streams close after this long, before the platform's limit; clients reconnect. */
  streamMaxMs?: number
  /**
   * Two-way sync, keyed by a name you choose: `{ slack: slack({...}), github: github({...}) }`. It
   * runs here, wherever the board lives: webhooks land at `<board>/webhooks/<key>`, and what the
   * board's channels say goes out to the platforms. On `http()`, the board it uses must let this
   * deployment `sync` in those channels.
   */
  sync?: Record<string, SyncProvider>
  /**
   * Runs on every post and edit before it reaches the backend, whatever it came from: the API,
   * sync, watchers, schedules, `client()`. Each calls `next()` to pass the write on; one that
   * doesn't drops it.
   */
  middleware?: readonly Middleware[]
}

/** What `board()` mounts: its handlers, and a client for your own server code. */
export type Board = {
  GET(request: Request): Promise<Response>
  POST(request: Request): Promise<Response>
  /** The same handler, for runtimes that take one function. */
  fetch(request: Request): Promise<Response>
  /**
   * A client for your own server code, writing as `name`: `vboard:client:<name>` on `a2()`, this
   * deployment with `name` as its profile on `http()`. With a `key` (a webhook delivery's ID, say),
   * its posts are idempotent: the same key and order never post twice. Its writes wake watchers
   * and sync like any other.
   */
  client(name: string, options?: { key?: string }): BoardClient
}

/** A host's `access` function rejected the request with this response. */
class Rejected {
  readonly response: Response
  constructor(response: Response) {
    this.response = response
  }
}

/** The methods whose answer is something new. */
const CREATED = new Set<Method>(['post', 'schedule', 'upload'])

/** Shown inline only when a browser can't run it: everything else downloads. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|text\/plain)$/

/**
 * The file, sandboxed: it can't run as a page on the board's origin, and only
 * types a browser can't execute display inline.
 */
function attachmentResponse({ attachment, data }: Protocol['attachment']['output']): Response {
  const disposition = INLINE.test(attachment.type) ? 'inline' : 'attachment'
  const body = data instanceof Uint8Array ? new Blob([data as Uint8Array<ArrayBuffer>]) : data
  return new Response(body, {
    headers: {
      'content-type': attachment.type,
      'content-length': String(attachment.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      // An ID's bytes never change.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}

/** A method's input, from the request: its path's `:id` or `:key`, its query, or its body, validated. */
async function inputOf(name: Method, request: Request, url: URL, params: Record<string, string>): Promise<unknown> {
  const id = params.id ?? ''
  const key = params.key ?? ''
  const body = () => readJson(request)
  switch (name) {
    case 'me':
    case 'channels':
    case 'actors':
    case 'identity':
    case 'watchers':
      return {}
    case 'message':
    case 'posted':
    case 'delete':
    case 'cancelSchedule':
    case 'attachment':
      return { id }
    case 'messages':
      return MessagesQuery.parse(queryObject(url))
    case 'threads':
      return ThreadsQuery.parse(queryObject(url))
    case 'schedules':
      return SchedulesQuery.parse(queryObject(url))
    case 'matches':
      return MatchesQuery.parse(queryObject(url))
    case 'events': {
      const query = EventsQuery.parse(queryObject(url))
      // SSE's own resume header, when the client reconnects by itself.
      const last = request.headers.get('last-event-id')
      if (query.after === undefined && last && Ref.safeParse(last).success) query.after = last
      return query
    }
    case 'post':
      return PostBody.parse(await body())
    case 'schedule':
      return ScheduleBody.parse(await body())
    case 'register':
      return RegisterBody.parse(await body())
    case 'edit':
      return { id, ...EditBody.parse(await body()) }
    case 'react':
      return { id, ...ReactBody.parse(await body()) }
    case 'label':
      return { id, ...LabelBody.parse(await body()) }
    case 'ack':
      return { id, ...AckBody.parse(await body()) }
    case 'upload': {
      const header = request.headers.get('x-board-filename')
      let name: string | null = null
      try {
        name = header === null ? null : decodeURIComponent(header)
      } catch {
        throw badRequest('`x-board-filename` is not URI-encoded')
      }
      return { data: await readCapped(request, ATTACHMENT_BYTES_MAX), name, type: request.headers.get('content-type') }
    }
    case 'syncImport':
      return SyncImportBody.parse(await body())
    case 'syncReceipt':
      return SyncReceiptBody.parse(await body())
    case 'syncThread':
      return { thread: params.thread ?? '' }
    case 'syncFind':
      return SyncFindQuery.parse(queryObject(url))
    case 'syncCopies':
      return SyncCopiesQuery.parse(queryObject(url))
    case 'syncRoots':
      return SyncRootsQuery.parse(queryObject(url))
    case 'inboxPush':
      return { key, ...InboxPushBody.parse(await body()) }
    case 'inboxNext':
      return { key, ...InboxNextQuery.parse(queryObject(url)) }
    case 'inboxAck':
      return { key, id, ...InboxAckBody.parse(await body()) }
    case 'inbox':
      return { key, ...InboxQuery.parse(queryObject(url)) }
    case 'syncCode':
      return SyncCodeBody.parse(await body())
    case 'syncAccount':
      return SyncAccountBody.parse(await body())
    case 'syncUnlink':
      return SyncUnlinkBody.parse(await body())
  }
}

/**
 * A sync callback's caller: the platform user its event came from, on sync entry `key`. Its client's
 * writes are imports as that user, and the rest it does as sync.
 */
type PlatformCaller = { platform: { author: ExternalAuthor; key: string }; origin: WriteOrigin }

/** A write's caller, as the middleware is told: where it came from. Its own client and sync's lookups skip it. */
const sourceOf = (caller: Caller): WriteSource | null => {
  const via = caller.origin.via
  if (via?.kind === 'middleware' || via?.kind === 'engine') return null
  return via ?? { kind: 'api' }
}

/**
 * A board for this project, on `backend`: `a2({ store, … })` keeps it in this deployment, and
 * `http(url)` uses another board that speaks the protocol. It serves the protocol over HTTP:
 * it routes and validates each request, verifies its token, works out who it writes as, and
 * calls the backend's method of the same name with that caller. Create it once, at module
 * scope, or one per tenant for a host.
 */
export function board(options: BoardOptions): Board {
  const { backend } = options
  const host = options.authenticate ?? null
  if (host && options.auth) throw new Error('board: authenticate replaces the built-in verifier, so drop `auth`')
  const watch = options.watch ?? {}
  const middleware = options.middleware ?? []
  const entries = options.sync ?? {}
  const engine = Object.keys(entries).length > 0 ? createSyncEngine(entries) : null
  const { verify } = createVerifier({
    projectId: () => ownProjectId(options.project),
    teamId: () => ownTeamId(options.project),
    // One of your own may leave it out: it trusts no other issuer then.
    issuers: backend.issuers ?? [],
    ...(options.auth ? { auth: options.auth } : {}),
  })
  const streamMaxMs = options.streamMaxMs ?? 280_000
  const route = createRouter(backend.routes, options.basePath)
  /** The mount path, as the last request that reached a route had it. */
  let learned: string | null = null

  async function verified(request: Request, boardUrl: string): Promise<Principal> {
    if (host) {
      let result: Awaited<ReturnType<Authenticate>>
      try {
        result = await host(request)
      } catch (error) {
        // A thrown `Response` rejects like a returned one.
        if (error instanceof Response) throw new Rejected(error)
        throw error
      }
      if (result instanceof Response) throw new Rejected(result)
      return hostPrincipal(result)
    }
    const header = request.headers.get('authorization') ?? ''
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) throw unauthorized('missing bearer token')
    return verify(token, boardUrl, request.headers.get('x-vercel-oidc-token') ?? undefined)
  }

  async function authenticate(request: Request, boardUrl: string): Promise<Principal> {
    const principal = await verified(request, boardUrl)
    // Set by a proxy that holds the credential (Pi's sandbox); it only narrows.
    const scope = request.headers.get('x-board-scope')
    if (scope === null) return principal
    try {
      parseScope(scope)
    } catch (error) {
      throw badRequest((error as Error).message, 'invalid_scope')
    }
    return { ...principal, scope }
  }

  /** The verified caller of a request: its principal, and the actor it writes as. */
  async function callerOf(request: Request, boardUrl: string): Promise<Caller> {
    const principal = await authenticate(request, boardUrl)
    const { author, actor } = resolveActor(principal, request.headers, boardUrl)
    return { identity: { principal, author, actor }, origin: { via: { kind: 'api' } } }
  }

  /**
   * This board's own URL, where a board elsewhere wakes it: `url`, or on Vercel its production
   * domain (a preview's own URL there), and never a request's Host, which its sender chooses.
   */
  function ownUrl(): string | null {
    if (options.url) return options.url.replace(/\/+$/, '')
    const domain = process.env.VERCEL_ENV === 'production' ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL
    const base = options.basePath ?? learned
    return domain && base !== null ? `https://${domain}${base}`.replace(/\/+$/, '') : null
  }

  /** An in-process client through the board, as `caller`: its posts are idempotent per trigger. */
  function clientAs(caller: Caller | PlatformCaller, trigger: string | null): BoardClient {
    let writesMade = 0
    return createBoardClient({
      // Under the configured mount, so the router accepts the paths it builds.
      url: `http://in-process.board${(options.basePath ?? '').replace(/\/+$/, '')}`,
      token: 'in-process',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init)
        if (trigger !== null && request.method === 'POST' && new URL(request.url).pathname.endsWith('/messages')) {
          const body = ((await request.json()) ?? {}) as Record<string, unknown>
          body.id ??= await idempotentId('vboard-inbound', trigger, 'client', String(writesMade++))
          request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
        }
        return dispatch(request, caller)
      }) as typeof fetch,
    })
  }

  /** The middleware's own client: its writes skip the middleware. */
  const middlewareCaller: Caller = { self: 'middleware', origin: { via: { kind: 'middleware' } } }
  /** Who an in-process caller is on its backend, asked once each: the middleware is told who's writing. */
  const selves = new Map<string, Promise<{ principal: string; actor: Actor }>>()
  async function whoIs(caller: Caller): Promise<{ principal: string; actor: Actor }> {
    if ('identity' in caller) return { principal: caller.identity.principal.id, actor: caller.identity.actor }
    const key = `${caller.origin.via?.kind ?? ''}\u001f${caller.self}`
    let found = selves.get(key)
    if (!found)
      selves.set(key, (found = backend.me(caller, {}, new AbortController().signal).then((me) => ({
        principal: me.principal,
        actor: { id: me.actor, kind: me.kind, handle: me.handle, name: me.name, avatar: me.avatar },
      }))))
    found.catch(() => selves.delete(key))
    return found
  }

  /**
   * Runs the middleware on a write, then `commit`s what it passed on. The middleware's own
   * client and sync's lookups skip it.
   */
  function screen<W extends Write, T>(
    write: W,
    context: { author: Actor; source: WriteSource | null; respond?: ((text: string) => Promise<void>) | undefined },
    commit: (write: W) => Promise<T>,
  ): Promise<T> {
    if (middleware.length === 0 || context.source === null) return commit(write)
    return runMiddleware(
      middleware,
      { write, author: context.author, source: context.source, board: () => clientAs(middlewareCaller, null), ...(context.respond ? { respond: context.respond } : {}) },
      commit,
    )
  }

  /**
   * `@[ada@vercel.com]`: an email a synced platform knows becomes that user's mention, and the
   * board learns who they are; the rest stay plain text.
   */
  async function withEmails(text: string): Promise<string> {
    // Each one sync finds, the board must know before a post can mention them; one it can't learn stays an email.
    const find = engine
      ? async (email: string) => {
          const actor = await engine.findByEmail(email)
          if (actor) await backend.syncImport(engine.caller, { op: 'seen', author: { ...actor, isBot: actor.bot === true } }, new AbortController().signal)
          return actor
        }
      : undefined
    return (await withEmailMentions(text, find)).text
  }

  /**
   * A sync target as the board that syncs it resolves it. One for an entry this board doesn't
   * have goes on as it is, for the sync that does, unless this board syncs: then it's a mistake.
   */
  async function resolveTarget(target: string | SyncTarget): Promise<SyncTarget> {
    if (typeof target !== 'string') return target
    const at = target.indexOf(':')
    if (at <= 0) throw badRequest(`sync targets look like <key>:<channel or thread>, got: ${target}`)
    const key = target.slice(0, at)
    if (engine && entries[key]) return engine.normalizeTarget(target)
    if (engine) throw badRequest(`no sync entry named ${key}`)
    return syncTarget(target)
  }

  /**
   * A message as `caller` may read it, or with `blind`, as the middleware may: a caller that
   * posts where it can't read still edits its own there. What a write's middleware is told about.
   */
  async function lookup(caller: Caller, id: string, signal: AbortSignal, blind = false): Promise<MessageView | null> {
    for (const reader of blind ? [caller, middlewareCaller] : [caller])
      try {
        const { message, replies } = await backend.message(reader, { id }, signal)
        const found = [message, ...replies].find((candidate) => candidate.id === id)
        if (found) return found
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error
      }
    return null
  }

  /** A post, through the middleware, with the targets its channel syncs with landing beside it. */
  async function post(caller: Caller, input: Protocol['post']['input'], signal: AbortSignal): Promise<Protocol['post']['output']> {
    const body = input.sync?.length ? { ...input, sync: await Promise.all(input.sync.map(resolveTarget)) } : input
    let poster = caller
    if (engine && body.channel !== undefined && !body.noSync) {
      const config = await engine.configTargets(body.channel)
      if (config.length > 0) poster = { ...caller, origin: { ...caller.origin, config } } as Caller
    }
    const send = async (patched: typeof body) => backend.post(poster, { ...patched, text: await withEmails(patched.text) }, signal)
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(body)
    // A retry of a post that landed: what's on the board stands, whatever the middleware would say now.
    // Only the backend knows whether its ID did, so it's asked first, and it answers the retry.
    if (body.id !== undefined && (await found(() => backend.posted(caller, { id: body.id! }, signal)))) return backend.post(poster, body, signal)
    // What it would put on the board: a reply lands in its root's channel.
    let channel = body.channel
    let re: string | null = null
    if (body.re !== undefined) {
      const target = await lookup(caller, body.re, signal)
      // A reply to what isn't there: the backend says so.
      if (!target) return send(body)
      channel = target.channel
      re = target.re ?? target.id
    }
    const attachments: Attachment[] = []
    for (const id of body.attachments ?? []) {
      const { attachment, data } = await backend.attachment(caller, { id }, signal)
      if (data instanceof ReadableStream) await data.cancel().catch(() => {})
      attachments.push(attachment)
    }
    const { actor } = await whoIs(caller)
    return screen(
      { kind: 'post', channel: channel!, re, text: body.text, labels: body.labels ?? {}, attachments },
      { author: actor, source, respond: caller.origin.respond },
      (write) => send({ ...body, text: write.text, labels: write.labels }),
    )
  }

  /** An edit, through the middleware. Only the author's own, of a message that's still there, reaches it. */
  async function edit(caller: Caller, input: Protocol['edit']['input'], signal: AbortSignal): Promise<Protocol['edit']['output']> {
    const send = async (text: string) => backend.edit(caller, { id: input.id, text: await withEmails(text) }, signal)
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(input.text)
    const [message, who] = await Promise.all([lookup(caller, input.id, signal, true), whoIs(caller)])
    // Not theirs, or gone: the backend says so.
    if (!message || message.deleted || message.by.principal !== who.principal) return send(input.text)
    return screen(
      { kind: 'edit', id: message.id, channel: message.channel, re: message.re, text: input.text },
      { author: who.actor, source, respond: caller.origin.respond },
      (write) => send(write.text),
    )
  }

  /** Whether a lookup found what it looked for: a 404 says it didn't. */
  async function found(lookup: () => Promise<unknown>): Promise<boolean> {
    try {
      await lookup()
      return true
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false
      throw error
    }
  }

  /**
   * What a sync callback's client does, on any backend. Its own writes are imports, as the platform
   * user the event came from, through the middleware like any import; everything else, its reads
   * included, it does as sync. A change it names by ID is an import that names it so.
   */
  async function asPlatform(name: Method, caller: PlatformCaller, input: unknown, signal: AbortSignal): Promise<unknown> {
    const sync = engine!
    const me = sync.caller
    const { author } = caller.platform
    const as = { author: externalActor(author), source: (caller.origin.via ?? { kind: 'api' }) as WriteSource, respond: caller.origin.respond }
    const change = async (body: Protocol['syncImport']['input']) => {
      const { message } = await backend.syncImport(me, body, signal)
      if (message === null) throw notFound(`message not found: #${(body as { message?: string }).message}`, 'message_not_found')
      return { ok: true as const }
    }
    switch (name) {
      case 'post':
        return importPost(caller, input as Protocol['post']['input'], signal)
      case 'edit': {
        const { id, text } = input as Protocol['edit']['input']
        const message = await lookup(me, id, signal)
        if (!message) throw notFound(`message not found: #${id}`, 'message_not_found')
        // Only the author's own; the backend says so for the rest.
        if (message.by.principal !== author.id || message.deleted) return change({ op: 'edit', author, from: null, message: id, text })
        return screen({ kind: 'edit', id, channel: message.channel, re: message.re, text }, as, async (write) =>
          change({ op: 'edit', author, from: null, message: id, text: await withEmails(write.text) }),
        )
      }
      case 'delete':
        return change({ op: 'delete', author, from: null, message: (input as Protocol['delete']['input']).id })
      case 'react': {
        const { id, emoji, remove } = input as Protocol['react']['input']
        return change({ op: 'react', author, from: null, message: id, emoji, ...(remove !== undefined ? { remove } : {}) })
      }
      case 'label': {
        const { id, set, unset } = input as Protocol['label']['input']
        return change({ op: 'labels', author, from: null, message: id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) })
      }
      default:
        return invoke(name, me, input, signal)
    }
  }

  /** A sync callback's post, as an import by its platform user: once per client ID, through the middleware. */
  async function importPost(caller: PlatformCaller, input: Protocol['post']['input'], signal: AbortSignal): Promise<Protocol['post']['output']> {
    const sync = engine!
    const me = sync.caller
    const { author } = caller.platform
    const read = async (id: string) => {
      const message = await lookup(me, id, signal)
      if (!message) throw notFound(`message not found: #${id}`, 'message_not_found')
      return message
    }
    // A retry of one that landed: it stands, and the middleware doesn't see it again.
    if (input.id !== undefined) {
      const landed = (await backend.syncFind(me, { post: input.id }, signal)).message
      if (landed !== null) return { message: await read(landed) }
    }
    const targets = await Promise.all((input.sync ?? []).map(resolveTarget))
    let channel = input.channel
    let re: string | null = null
    if (input.re !== undefined) {
      const target = await read(input.re)
      channel = target.channel
      re = target.re ?? target.id
    }
    const attachments: Attachment[] = []
    for (const id of input.attachments ?? []) {
      const { attachment, data } = await backend.attachment(me, { id }, signal)
      if (data instanceof ReadableStream) await data.cancel().catch(() => {})
      attachments.push(attachment)
    }
    // A new root lands with the targets its channel syncs with, as any post through board() does.
    const config = input.channel !== undefined && !input.noSync ? await sync.configTargets(input.channel) : []
    const importer: Caller = config.length > 0 ? { ...me, origin: { ...me.origin, config } } : me
    return screen(
      { kind: 'post', channel: channel!, re, text: input.text, labels: input.labels ?? {}, attachments },
      { author: externalActor(author), source: (caller.origin.via ?? { kind: 'api' }) as WriteSource, respond: caller.origin.respond },
      async (write) => {
        const { message } = await backend.syncImport(importer, {
          op: 'post',
          author,
          from: null,
          origin: null,
          ...(input.channel !== undefined ? { channel: input.channel } : { re: input.re! }),
          text: await withEmails(write.text),
          labels: write.labels,
          ...(input.noSync ? { noSync: true } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.id !== undefined ? { id: input.id } : {}),
        }, signal)
        // The targets it asked for, as sync records a thread's.
        for (const target of targets)
          await backend.syncReceipt(me, { kind: 'thread', message: message!, target: target.target, targetKind: target.kind, cause: 'request' }, signal)
        return { message: await read(message!) }
      },
    )
  }

  /** The protocol method `name`, as board() serves it: a post and an edit through the middleware first. */
  async function invoke(name: Method, caller: Caller, input: unknown, signal: AbortSignal): Promise<unknown> {
    switch (name) {
      case 'post':
        return post(caller, input as Protocol['post']['input'], signal)
      case 'edit':
        return edit(caller, input as Protocol['edit']['input'], signal)
      case 'identity': {
        // Which sync entries have no account linked is this board's to say: it has the entries.
        const view = await backend.identity(caller, {}, signal)
        const unlinked = Object.entries(entries)
          .filter(([, entry]) => !view.links.some((link) => link.actor.startsWith(`${entry.platform}:user:`)))
          .map(([key]) => key)
        return { ...view, unlinked }
      }
      case 'inbox': {
        const query = input as Protocol['inbox']['input']
        // A channel by name, for an entry this board has: its platform ID.
        if (engine && entries[query.key] && query.channel !== undefined) return backend.inbox(caller, { ...query, channel: await engine.inboxChannel(query.key, query.channel) }, signal)
        return backend.inbox(caller, query, signal)
      }
      default: {
        const method = backend[name] as unknown
        if (typeof method !== 'function') throw notFound(`no route: ${name}`)
        return (method as (caller: Caller, input: unknown, signal: AbortSignal) => Promise<unknown>).call(backend, caller, input, signal)
      }
    }
  }

  const needSync = (): SyncEngine => {
    if (!engine) throw notFound('this board has no sync configured')
    return engine
  }

  /** What `caller` may do, as the backend says: board() decides nothing itself. */
  const accessOf = async (caller: Caller, signal: AbortSignal): Promise<Access> => compileAccess((await backend.me(caller, {}, signal)).can)

  /** This board's own code, for what it looks up itself: the syncs registered here. */
  const boardCaller: Caller = { self: 'board', origin: { via: { kind: 'client', name: 'board' } } }
  /** This board's sync entries, as its sync and discovery see them. */
  const ownEntries: SyncEntry[] = Object.entries(entries).map(([key, entry]) => ({ key, platform: entry.platform, signIn: entry.users !== null }))
  let registered: { at: number; list: Promise<RegistrationView[]> } | null = null
  /** The syncs registered here: another board's, which link accounts and import through this one. Discovery asks at most every 10 seconds. */
  function registrants(fresh = false): Promise<RegistrationView[]> {
    if (fresh || !registered || Date.now() - registered.at > 10_000) {
      const list = backend.watchers(boardCaller, {}, new AbortController().signal).then(
        ({ watchers }) => watchers.filter((registration) => registration.sync?.length),
        () => [] as RegistrationView[],
      )
      registered = { at: Date.now(), list }
    }
    return registered.list
  }
  /** Every sync entry this board links accounts on: its own, then each registrant's, by key. */
  async function syncEntries(fresh = false): Promise<(SyncEntry & { url: string | null; own: boolean })[]> {
    const found = new Map<string, SyncEntry & { url: string | null; own: boolean }>()
    for (const entry of ownEntries) found.set(entry.key, { ...entry, url: ownUrl(), own: true })
    for (const registration of await registrants(fresh))
      for (const entry of registration.sync) if (!found.has(entry.key)) found.set(entry.key, { ...entry, url: registration.url, own: false })
    return [...found.values()]
  }
  const needPerson = (caller: Caller): string => {
    if (!('identity' in caller) || caller.identity.principal.kind !== 'person') throw forbidden('only people link platform accounts')
    return caller.identity.principal.id
  }

  /**
   * A sign-in that carries a code, where the entry's sync runs: a browser opens it with no token,
   * so the code is all it has. `signIn` sends the person to the platform as whoever the code was
   * issued to; `signedIn`, where the platform sends them back, links the account they approved.
   */
  async function signingIn(name: 'signIn' | 'signedIn', url: URL, signal: AbortSignal): Promise<Response> {
    const { sync: key, code } = SignInQuery.parse(queryObject(url))
    if (!engine || !entries[key]) throw notFound(`no sync entry named ${key}`)
    const page = (status: number, text: string) => new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    const { holder } = await backend.syncFind(engine.caller, { code }, signal)
    if (holder === null) return page(404, "That link has expired or been used. Run `vb identity link` again for a new one.")
    if (name === 'signIn') {
      const back = ownUrl()
      const at = await engine.signIn(key, holder, back ? `${back}/identity/signed-in?${new URLSearchParams({ sync: key, code })}` : undefined)
      return new Response(null, { status: 302, headers: { location: at } })
    }
    const linked = await engine.redeemSignIn(key, holder, code)
    if (!linked) return page(409, `${entries[key]!.platform} hasn't said you approved yet: finish signing in, then open this page again.`)
    return page(200, `Linked ${linked.handle ? `@${linked.handle}` : linked.actor}. You can close this tab.`)
  }

  /** board()'s own routes that need a verified caller: sync's, which run where board() does. */
  async function serve(name: BoardRoute, caller: Caller, request: Request, url: URL, params: Record<string, string>): Promise<Response> {
    const signal = request.signal
    switch (name) {
      case 'sync': {
        // Attaching a thread is a `thread` receipt, recorded as the caller: it needs `sync` where the thread is,
        // which a request's caller shows before its target goes to the platform to resolve.
        const body = SyncBody.parse(await readJson(request))
        if ('identity' in caller && engine) {
          const message = await lookup(caller, params.id ?? '', signal)
          if (!message) throw notFound(`message not found: #${params.id}`, 'message_not_found')
          if (!(await accessOf(caller, signal)).can('sync', message.channel)) throw forbidden(`this token can't sync in ${message.channel}`)
        }
        const target = await resolveTarget(body.target)
        const { attached } = await backend.syncReceipt(caller, { kind: 'thread', message: params.id ?? '', target: target.target, targetKind: target.kind, cause: 'request' }, signal)
        return json({ target: target.target, attached: attached ?? true })
      }
      case 'typing': {
        // Typing is a reply about to come: `post` and `read` where the thread is.
        const body = TypingBody.parse(await readJson(request)) ?? {}
        const id = params.id ?? ''
        const { message: root, replies } = await backend.message(caller, { id }, signal)
        const message = [root, ...replies].find((candidate) => candidate.id === id)
        if (!message || message.deleted) throw notFound(`message not found: #${id}`, 'message_not_found')
        if (!(await accessOf(caller, signal)).can('post', message.channel)) throw forbidden(`this token can't post in ${message.channel}`)
        return json({ targets: engine ? await engine.typing([root, ...replies], body.status) : [] })
      }
      case 'sourceRead': {
        // The app's token reads what the app can, not what the caller can.
        if (!(await accessOf(caller, signal)).everywhere('manage')) throw forbidden("this token can't read a source: it needs manage in every channel")
        const query = SourceReadQuery.parse(queryObject(url))
        return json(await needSync().readSource(params.key ?? '', query.target, query.limit ?? 50))
      }
      case 'identityLink': {
        const body = IdentityLinkBody.parse(await readJson(request))
        const known = await syncEntries(true)
        if (known.length === 0) throw notFound('this board has no sync configured')
        const entry = known.find((candidate) => candidate.key === body.sync)
        if (!entry) throw notFound(`no sync entry named ${body.sync}`)
        const person = needPerson(caller)
        // A sign-in where the entry's sync runs and can be reached; a code to post from the account otherwise.
        const signs = entry.signIn && (entry.own || entry.url !== null)
        if (body.method === 'consent' && !signs) throw badRequest(`${body.sync} can't sign people in: link it with a code`)
        if (body.method !== 'code' && signs) {
          // The board that keeps the log issues the code; the sign-in carries it, and the sync redeems it.
          if (entry.own) return json({ method: 'consent', sync: entry.key, platform: entry.platform, url: await engine!.signIn(entry.key, person) })
          const { code } = await backend.syncCode(caller, { sync: entry.key }, signal)
          const at = `${entry.url}/identity/sign-in?${new URLSearchParams({ sync: entry.key, code })}`
          return json({ method: 'consent', sync: entry.key, platform: entry.platform, url: at })
        }
        const { code, expiresAt } = await backend.syncCode(caller, { sync: entry.key }, signal)
        return json({ method: 'code', sync: entry.key, platform: entry.platform, code, expiresAt })
      }
      case 'identityCheck': {
        const body = IdentityCheckBody.parse(await readJson(request))
        const known = await syncEntries(true)
        if (known.length === 0) throw notFound('this board has no sync configured')
        const entry = known.find((candidate) => candidate.key === body.sync)
        if (!entry) throw notFound(`no sync entry named ${body.sync}`)
        const person = needPerson(caller)
        // A sign-in elsewhere links where it comes back: the person sees it in their links.
        if (!entry.own) return json({ linked: null })
        if (!entry.signIn) throw badRequest(`${body.sync} can't sign people in: link it with a code`)
        // Their sign-in, here: once it's done, a code of their own links the account it authorized.
        const account = await engine!.signedIn(entry.key, person)
        if (!account) return json({ linked: null })
        const { code } = await backend.syncCode(caller, { sync: entry.key }, signal)
        return json({ linked: (await backend.syncAccount(engine!.caller, { sync: entry.key, account, code, method: 'consent' }, signal)).link })
      }
      case 'identityUnlink': {
        needPerson(caller)
        const body = IdentityUnlinkBody.parse(await readJson(request))
        const { links } = await backend.identity(caller, {}, signal)
        const wanted = body.actor.replace(/^@/, '').toLowerCase()
        const found = links.filter((link) => link.actor === body.actor || link.handle?.toLowerCase() === wanted).map((link) => link.actor)
        if (found.length === 0) throw notFound(`${body.actor} isn't linked to you`, 'not_linked')
        if (found.length > 1) throw badRequest(`${body.actor} names several of your accounts: use ${found.join(' or ')}`, 'ambiguous_actor')
        await backend.syncUnlink(caller, { account: found[0]! }, signal)
        return json({ ok: true, actor: found[0]! })
      }
      default:
        throw notFound(`no route: ${request.method} ${url.pathname}`)
    }
  }

  const subscriptions: Record<string, Subscription> = Object.fromEntries(
    Object.entries(watch).map(([id, watcher]) => [id, { kind: 'tail', tail: watcher.tail, when: watcher.when ?? 'matches' }]),
  )
  if (engine) subscriptions[SYNC] = { kind: 'sync' }
  const binding: BoardBinding = {
    subscriptions,
    async run(id, event, { trigger, attempt }) {
      if (id === SYNC && engine) return engine.deliver(event as SyncEvent, { attempt })
      const watcher = watch[id]
      if (!watcher) throw new Error(`this board has no watcher ${id}`)
      await watcher.run({ event, board: clientAs({ self: id, origin: { via: { kind: 'watcher', id } } }, trigger) })
    },
    async receive(key, item, { id, attempt }) {
      if (!engine) throw new Error(`this board has no sync, so nothing reads ${key}'s inbox`)
      await engine.receive(key, item, { id, attempt })
    },
    pull: () => (engine ? engine.pull() : Promise.resolve(0)),
    sync: ownEntries,
    project: async () => ({ id: await ownProjectId(options.project), teamId: await ownTeamId(options.project) }),
    client: clientAs,
    url: ownUrl,
  }
  backend.bind(binding)
  engine?.bind({
    backend,
    screen: (write, context, commit) => screen(write, context, commit),
    client: (platform, trigger) => clientAs({ platform: { author: platform.author, key: platform.key }, origin: platform.origin }, trigger),
  })

  /** Server-sent events, from the backend's long-poll: each event's `id` is its cursor, so `Last-Event-ID` resumes exactly. */
  async function sse(caller: Caller, query: Protocol['events']['input'], request: Request): Promise<Response> {
    // The first page now, so a bad cursor or a refusal answers as an error instead of a stream.
    const first = await backend.events(caller, { ...query, wait: 0 }, request.signal)
    const encoder = new TextEncoder()
    const controller = new AbortController()
    const deadline = Date.now() + streamMaxMs
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(streamMaxMs)])
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        const send = (text: string) => {
          try {
            stream.enqueue(encoder.encode(text))
          } catch {}
        }
        const ping = setInterval(() => send(': ping\n\n'), 15_000)
        try {
          send(': connected\n\n')
          let page = first
          let after: string | undefined
          for (;;) {
            for (const event of page.events) send(`id: ${event.cursor}\nevent: board\ndata: ${JSON.stringify(event)}\n\n`)
            // Filtered-out events still advance the client's cursor with a bare `id:`, the first page's included.
            if (page.cursor !== (page.events.at(-1)?.cursor ?? after)) send(`id: ${page.cursor}\n\n`)
            after = page.cursor
            const left = deadline - Date.now()
            if (signal.aborted || left <= 0) break
            page = await backend.events(caller, { ...query, after, wait: Math.min(300, left / 1000) }, signal)
          }
        } catch (error) {
          if (!signal.aborted) console.error('[vboard] feed failed', error)
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

  async function dispatch(request: Request, injected: Caller | PlatformCaller | null): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = route(request.method, url.pathname)
      if (!match) throw notFound(`no route: ${request.method} ${url.pathname}`)
      const { target } = match
      if (!injected && !(target.kind === 'board' && target.name === 'discovery')) learned = match.base
      const boardUrl = (options.url ?? `${url.origin}${match.base}`).replace(/\/+$/, '')

      if (target.kind === 'board' && target.name === 'webhook') {
        // A platform can't send a board token: its adapter verifies the request.
        if (!engine || !entries[match.params.key ?? '']) throw notFound(`no sync entry named ${match.params.key}`)
        return await engine.handleWebhook(match.params.key!, request)
      }
      if (target.kind === 'board' && (target.name === 'signIn' || target.name === 'signedIn')) return await signingIn(target.name, url, request.signal)
      // A sync callback's client does everything but its own writes as sync.
      const own = injected && 'platform' in injected ? engine!.caller : injected
      if (target.kind === 'board' && target.name !== 'avatar' && target.name !== 'openapi' && target.name !== 'discovery') {
        const caller = own ?? (await callerOf(request, boardUrl))
        return await serve(target.name, caller, request, url, match.params)
      }

      if (target.kind === 'board') {
        if (target.name === 'avatar') {
          const name = match.param ?? ''
          if (!(KNOWN_AGENTS as readonly string[]).includes(name)) throw notFound(`no avatar: ${name}`)
          return new Response(avatarSvg(name), {
            headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
          })
        }
        if (target.name === 'openapi') return json(openapi())
        const identity = await discoveryIdentity(request, options.project)
        const body: Discovery = {
          version: VERSION,
          url: boardUrl,
          audience: boardUrl,
          team_id: identity.teamId,
          project_id: identity.projectId,
          // Its own sync's entries, and those of the syncs registered here, which link accounts here too.
          sync: (await syncEntries()).map(({ key, platform }) => ({ key, platform })),
          ...(backend.remote !== null ? { remote: backend.remote } : {}),
        }
        return json(body)
      }

      if (target.kind === 'backend') {
        const caller = own ?? (target.route.auth ? await callerOf(request, boardUrl) : null)
        return await target.route.handle(request, { caller, param: match.param })
      }

      if (typeof (backend[target.name] as unknown) !== 'function') throw notFound(`no route: ${request.method} ${url.pathname}`)
      const caller = own ?? (await callerOf(request, boardUrl))
      const input = await inputOf(target.name, request, url, match.params)
      if (target.name === 'events' && (request.headers.get('accept') ?? '').includes('text/event-stream'))
        return await sse(caller, input as Protocol['events']['input'], request)
      const output = injected && 'platform' in injected ? await asPlatform(target.name, injected, input, request.signal) : await invoke(target.name, caller, input, request.signal)
      if (target.name === 'attachment') return attachmentResponse(output as Protocol['attachment']['output'])
      return json(output, CREATED.has(target.name) ? 201 : 200)
    } catch (error) {
      if (error instanceof Rejected) return error.response
      return toErrorResponse(error)
    }
  }

  const handle = (request: Request) => dispatch(request, null)
  return {
    GET: handle,
    POST: handle,
    fetch: handle,
    client(name, clientOptions = {}) {
      const key = clientOptions.key === undefined ? null : `client:${name}:${clientOptions.key}`
      return clientAs({ self: name, origin: { via: { kind: 'client', name } } }, key)
    },
  }
}
