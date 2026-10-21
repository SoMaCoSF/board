import type { BoardEventView } from '../api/routes.ts'
import { BoardError, createBoardClient, type BoardClient, type PostOptions, type ProfileOption, type ReplyOptions } from '../client/client.ts'
import { derivedId } from '../client/ids.ts'
import type { SyncProvider } from '../sync/provider.ts'
import { SYNC, type Backend, type BoardBinding, type Caller, type Subscription, type SyncEntry } from './backend.ts'
import type { Authenticate, AuthOptions } from './auth.ts'
import type { Middleware } from './middleware.ts'
import { createServe, type PlatformCaller, type Serve } from './serve.ts'
import type { Watcher } from './watch.ts'

/** `board()`'s options: where the board lives, who may use it, and what runs here. */
export type BoardOptions = {
  /**
   * Where the board lives: `a2({ … })` from `vboard/backend-a2` keeps it here, `http(url)` from
   * `vboard/backend-http` uses another, or your own. By default, `http()`: in Node, the board the
   * environment points at (`VBOARD_URL`, the repo's link, or `vb use`'s).
   */
  backend?: Backend
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
   * sync, watchers, schedules, the handle. Each calls `next()` to pass the write on; one that
   * doesn't drops it.
   */
  middleware?: readonly Middleware[]
}

/**
 * The handle on a board: its methods act as the board's caller, through board(), which calls the
 * backend's methods, and `fetch` serves it. Over `http()` the caller is whoever its `fetch`'s
 * credentials say, with the profile `VBOARD_AS` or the agent it runs in picks; on a board it keeps
 * (`a2()`), its own code, as `vboard:client`.
 */
export type Board = BoardClient & {
  /**
   * The board's HTTP handler, for a route file (`export const GET = team.fetch, POST = team.fetch`)
   * or any runtime that takes one function.
   */
  fetch(request: Request): Promise<Response>
  /**
   * The handle, acting with `profile`: `<principal>+<profile>` over HTTP, `vboard:client:<profile>`
   * on `a2()`. `null` acts as yourself, outside any agent session.
   */
  as(profile: ProfileOption): Board
}

/** What a board needs to serve requests: token verification, and its own Vercel project. */
export type Serving = typeof import('./serving.ts')

/** What a build of vboard gives board(): Node's finds boards in the environment, serves, and syncs. */
export type Runtime = {
  /** The backend for a board() given none: `http()`, to the board the environment points at. */
  http(): Backend
  /** Loads what serving requests needs. Null where it can't serve. */
  serving: (() => Promise<Serving>) | null
  /** Loads the sync engine, for a board that syncs. Null where sync can't run. */
  sync: (() => Promise<typeof import('../sync/engine.ts')>) | null
}

/** What the board's pipeline shares with its handle. */
export type BoardContext = {
  options: BoardOptions
  backend: Backend
  runtime: Runtime
  /** The mount path, as the last request that reached a route had it. */
  state: { learned: string | null }
  ownUrl(): string | null
  /** An in-process client through the board, as `caller`: its posts are idempotent per trigger. */
  clientAs(caller: Caller | PlatformCaller, trigger: string | null): BoardClient
  /** The handle, acting as `caller`: a watcher's, or the middleware's. */
  handleOf(caller: Extract<Caller, { self: string | null }>, trigger: string | null): Board
}

const NO_SYNC = "board: this build of vboard can't sync: import it where the `node` condition applies"

/** How long a handle's live events wait for the next, in seconds, before asking again. */
const EVENTS_WAIT_S = 25

/**
 * A board for this project, on `backend`: `a2({ store, … })` keeps it in this deployment, and
 * `http(url)` uses another board that speaks the protocol. What it returns is the handle: its
 * methods act as the board's caller, and `fetch` serves the protocol over HTTP. Create it once,
 * at module scope, or one per tenant for a host.
 */
export function createBoard(options: BoardOptions, runtime: Runtime): Board {
  if (options.authenticate && options.auth) throw new Error('board: authenticate replaces the built-in verifier, so drop `auth`')
  const backend = options.backend ?? runtime.http()
  const watch = options.watch ?? {}
  const entries = options.sync ?? {}
  if (Object.keys(entries).length > 0 && !runtime.sync) throw new Error(NO_SYNC)
  const state: BoardContext['state'] = { learned: null }
  /** Under the configured mount, so the router accepts the paths an in-process client builds. */
  const inProcess = `http://in-process.board${(options.basePath ?? '').replace(/\/+$/, '')}`

  /**
   * This board's own URL, where a board elsewhere wakes it: `url`, or on Vercel its production
   * domain (a preview's own URL there), and never a request's Host, which its sender chooses.
   */
  function ownUrl(): string | null {
    if (options.url) return options.url.replace(/\/+$/, '')
    const env = typeof process === 'undefined' ? undefined : process.env
    const domain = env?.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : env?.VERCEL_URL
    const base = options.basePath ?? state.learned
    return domain && base !== null ? `https://${domain}${base}`.replace(/\/+$/, '') : null
  }

  let loading: Promise<Serve> | null = null
  /** The board's pipeline, made once, when the board first serves, watches, syncs, or a handle calls it. */
  function server(): Promise<Serve> {
    loading ??= createServe(context)
    loading.catch(() => (loading = null))
    return loading
  }

  function clientAs(caller: Caller | PlatformCaller, trigger: string | null): BoardClient {
    const writes = { made: 0 }
    return createBoardClient({
      url: inProcess,
      token: 'in-process',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (await server()).inject(new Request(input, init), caller, trigger, writes)) as typeof fetch,
    })
  }

  const serve = async (request: Request): Promise<Response> => (await server()).dispatch(request, null)

  /** A handle on `client`, which `as` gives other profiles of. */
  function handle(client: BoardClient, url: (() => string) | null): Board {
    const made = { ...client, fetch: serve, as } as Board
    if (url) Object.defineProperty(made, 'url', { get: url, enumerable: true })
    return made
  }

  /**
   * A handle through board(), as `caller`: a post's or schedule's `id` is its own, derived under who
   * it writes as, so a retry writes once and no request can take it first.
   */
  function handleOf(caller: Extract<Caller, { self: string | null }>, trigger: string | null): Board {
    const client = clientAs(caller, trigger)
    const via = caller.origin.via?.kind ?? 'client'
    const id = (given: string) => derivedId(`vboard-${via === 'watcher' ? 'watch' : via}`, caller.self ?? '', given)
    const owned = async <T extends PostOptions | ReplyOptions>(input: string | T): Promise<string | T> =>
      typeof input === 'string' || input.id === undefined ? input : { ...input, id: await id(input.id) }
    return handle(
      {
        ...client,
        post: async (channel, input) => client.post(channel, await owned(input)),
        reply: async (re, input) => client.reply(re, await owned(input)),
        schedule: async (target, input) => client.schedule(target, input.id === undefined ? input : { ...input, id: await id(input.id) }),
        posted: async (given) => client.posted(await id(given)),
        // In-process, a request is this caller's whatever its headers say: another profile is another handle's.
        request: (path, init = {}) => {
          const { as: profile, ...rest } = init
          return profile !== undefined ? as(profile).request(path, rest) : client.request(path, rest)
        },
        events: (query, opts) => events(client, query, opts),
      },
      () => ownUrl() ?? inProcess,
    )
  }

  const profileCaller = (profile: ProfileOption): Extract<Caller, { self: string | null }> => {
    const name = profile === null ? null : typeof profile === 'string' ? profile : profile.name
    return { self: name, profile, origin: { via: { kind: 'client', name } } }
  }

  function as(profile: ProfileOption): Board {
    return handleOf(profileCaller(profile), null)
  }

  const context: BoardContext = { options, backend, runtime, state, ownUrl, clientAs, handleOf }

  const subscriptions: Record<string, Subscription> = Object.fromEntries(
    Object.entries(watch).map(([id, watcher]) => [id, { kind: 'tail', tail: watcher.tail, when: watcher.when ?? 'matches' }]),
  )
  if (Object.keys(entries).length > 0) subscriptions[SYNC] = { kind: 'sync' }
  /** This board's sync entries, as its sync and discovery see them. */
  const ownEntries: SyncEntry[] = Object.entries(entries).map(([key, entry]) => ({ key, platform: entry.platform, signIn: entry.users !== null }))
  const binding: BoardBinding = {
    subscriptions,
    run: async (id, event, meta) => (await server()).run(id, event, meta),
    failed: async (id, event, meta) => (await server()).failed(id, event, meta),
    receive: async (key, item, meta) => (await server()).receive(key, item, meta),
    pull: async () => (ownEntries.length > 0 ? (await server()).pull() : 0),
    sync: ownEntries,
    project: async () => (await server()).project(),
    client: clientAs,
    url: ownUrl,
  }
  backend.bind(binding)

  return handleOf({ self: null, origin: { via: { kind: 'client', name: null } } }, null)
}

/**
 * Live events for a handle, from the backend's long-poll: each page from the last cursor it saw,
 * waiting for the next. It backs off after a failure, up to 30 seconds; a 4xx throws.
 */
async function* events(
  client: BoardClient,
  query: Parameters<BoardClient['events']>[0] = {},
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<BoardEventView> {
  let after = query.after
  let failures = 0
  while (!opts.signal?.aborted) {
    let page: Awaited<ReturnType<BoardClient['poll']>>
    try {
      page = await client.poll({ ...query, ...(after !== undefined ? { after } : {}), wait: EVENTS_WAIT_S } as Parameters<BoardClient['poll']>[0], opts.signal)
    } catch (error) {
      if (opts.signal?.aborted) return
      if (error instanceof BoardError && error.status >= 400 && error.status < 500) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** failures++)))
      continue
    }
    failures = 0
    for (const event of page.events) {
      yield event
      if (opts.signal?.aborted) return
    }
    after = page.cursor
  }
}
