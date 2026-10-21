import { RegisterBody, routes, type Discovery, type MatchView, type RegistrationView } from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import { BoardError, createBoardClient, type BoardClient, type ProfileOption } from '../client/client.ts'
import { DERIVED_ID, keyId, sha256 } from '../client/ids.ts'
import type { Attachment } from '../contract/schemas.ts'
import { SYNC, type Backend, type BackendRoute, type BoardBinding, type Caller, type ProtocolMethods } from './backend.ts'
import { HttpError, json } from './errors.ts'
import { METHODS } from './routing.ts'
import { canonicalWatchers, type SyncEntrySpec, type WatcherSpec } from './watchers-hash.ts'

export type HttpOptions = {
  /**
   * How requests reach the board, with the credentials it recognizes. In Node it defaults to what
   * `vb` uses: a token from `VBOARD_TOKEN`, `vb serve`'s, GitHub Actions, Vercel, or `vercel login`,
   * through Deployment Protection. In a browser, `fetch`, sending the page's own session (a cookie,
   * say), which the board's `authenticate` recognizes.
   */
  fetch?: typeof fetch
}

/**
 * What finds a board and reaches it, in the Node build: the environment, its files, and
 * `vercel login`. A browser has none.
 */
export type Environment = {
  /** The board the environment points at. Throws `no_board` when it points at none. */
  url(): string
  /** The fetch for the board at `url` when none is given: the credentials `vb` uses, through Deployment Protection. */
  fetch(url: string): typeof fetch
  /** The profile the environment picks (`VBOARD_AS`, or the coding agent it runs in), and that agent's session. */
  profile(): { profile: ProfileOption; session: string | null }
  /** Checks a watcher's tail, throwing what's wrong with it. */
  checkWatcher(id: string, spec: { tail: string; when?: 'matches' | 'enters' | undefined }): void
}

/** A watcher's or client's name is the profile its writes are by. */
const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const PROFILE_RULE = 'ids start with a letter and use up to 32 letters, numbers, and hyphens'

/** Registering again this soon after the same registration only repeats it. */
const REGISTER_EVERY_MS = 10_000
/** How long one wake-up runs matches before it leaves the rest to the next. */
const DRAIN_MS = 4 * 60_000
/** A pull with nothing to hand out holds this long, when the board pulls on its own. */
const POLL_WAIT_S = 25

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

/** The SDK's error, as the board answers it: the remote's own status and code, or 502 when it never answered. */
const rethrow = (error: unknown): never => {
  if (error instanceof BoardError) throw new HttpError(error.status >= 400 ? error.status : 502, error.code, error.message)
  if (error instanceof HttpError || (error instanceof Error && error.name === 'AbortError')) throw error
  throw new HttpError(502, 'unreachable', `the board didn't answer: ${describe(error)}`)
}

/** A parsed input, back on the wire as a query string. */
function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    // A flag left off is false: `all=false` would read as true.
    if (value === undefined || value === null || value === false) continue
    // Label filters parse to `[key, values | null]`.
    if (key === 'label' && Array.isArray(value))
      for (const [name, values] of value as [string, string[] | null][]) params.append('label', values === null ? name : `${name}=${values.join('|')}`)
    else if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** A file the remote served, as the board stored it: its headers say what it is. */
function attachmentOf(id: string, response: Response): Protocol['attachment']['output'] {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  let name = 'file'
  try {
    if (encoded) name = decodeURIComponent(encoded)
  } catch {}
  const attachment: Attachment = {
    id,
    name,
    type: response.headers.get('content-type') ?? 'application/octet-stream',
    size: Number(response.headers.get('content-length') ?? 0),
  }
  return { attachment, data: response.body ?? new Uint8Array() }
}

/**
 * Another board that speaks the protocol, at `url` (in Node, the one the environment points at
 * by default): this board keeps nothing, and this deployment reads and writes that one as itself.
 * Its watchers' tails are registered there. The remote wakes it when one matches, with nothing in
 * the wake-up but a hash, and it pulls what matched with its own credentials, runs it, and acks
 * it. When it can't be woken (no https URL of its own: a dev server, say), it pulls on its own.
 */
export function createHttp(url: string | undefined, options: HttpOptions, environment: Environment | null) {
  if (url !== undefined && !/^https?:\/\/[^/]/.test(url)) throw new Error(`http: ${url} isn't a URL: pass the board's, like https://board.example.com/api/board`)
  if (url === undefined && !environment) throw new Error("http: pass the board's URL: outside Node there's no environment to find it in")
  const remote = (url ?? environment!.url()).replace(/\/+$/, '')
  const doFetch: typeof fetch = options.fetch ?? environment?.fetch(remote) ?? ((input, init) => globalThis.fetch(input, init))
  let binding: BoardBinding | null = null
  const specs: Record<string, WatcherSpec> = {}
  /** This board's sync entries, registered there when it syncs. */
  let sync: SyncEntrySpec[] = []
  let hash: Promise<string> | null = null
  /** What every wake-up carries, so the board it uses can tell it's stale. */
  const watchersHash = () => (hash ??= sha256(canonicalWatchers(specs, sync)).then((hex) => hex.slice(0, 32)))
  const bound = () => {
    if (!binding) throw new Error("http: this backend isn't serving a board yet: pass it to board({ backend })")
    return binding
  }

  /**
   * The SDK against the remote, as this deployment with `profile`. `quiet` names no session: this
   * deployment's own code. Otherwise a profile chosen in code keeps the environment's session, and
   * yourself (`null`) has none. Who the token's holder is, `fetch` says.
   */
  const sdk = (profile: ProfileOption | undefined, quiet: boolean) =>
    createBoardClient({
      url: remote,
      fetch: doFetch,
      profile: profile !== undefined ? profile : () => environment?.profile().profile ?? null,
      session: quiet || profile === null ? null : () => environment?.profile().session ?? null,
    })

  const own = sdk(null, true)
  const profiles = new Map<string, BoardClient>()
  /** This deployment as `profile`: a watcher's ID, or the middleware. */
  function asProfile(profile: string): BoardClient {
    if (!PROFILE.test(profile)) throw new HttpError(400, 'invalid_request', `as: ${profile}: profiles start with a letter and use up to 32 letters, numbers, and hyphens`)
    let client = profiles.get(profile)
    if (!client) profiles.set(profile, (client = sdk(profile, true)))
    return client
  }
  const holders = new Map<string, BoardClient>()
  /** The token's holder, with `profile` (`undefined`: the environment's). */
  function holder(profile: ProfileOption | undefined): BoardClient {
    const key = JSON.stringify(profile ?? (profile === null ? null : '\u0000'))
    let client = holders.get(key)
    if (!client) holders.set(key, (client = sdk(profile, false)))
    return client
  }

  /** What this deployment answers itself: wake-ups and webhooks. Everything else is the board it uses'. */
  const servesOnly = () => new HttpError(404, 'not_found', `${bound().url() ?? 'this board'} answers only wake-ups and webhooks`)

  /**
   * The client a caller's call goes through: a handle's, as the token's holder with its profile;
   * a watcher's or the middleware's, as this deployment with theirs; and sync's, as the deployment
   * itself. A request from anyone else isn't this deployment's to answer.
   */
  function clientOf(caller: Caller): BoardClient {
    if ('identity' in caller) throw servesOnly()
    if (caller.origin.via?.kind === 'engine') return own
    if (caller.origin.via?.kind === 'client') {
      if (caller.self !== null) asProfile(caller.self)
      // The handle itself is whoever the environment picks; `as()` names its own, or none.
      return holder('profile' in caller ? caller.profile : caller.self ?? undefined)
    }
    return asProfile(caller.self ?? 'client')
  }

  let discovered: Promise<Discovery> | null = null
  /** The board it uses' discovery, for a handle here: who it is, and the sync entries it lists. */
  const discovery = () =>
    (discovered ??= doFetch(remote).then(async (response) => {
      if (!response.ok) throw new HttpError(response.status >= 400 ? response.status : 502, 'no_board', `no board at ${remote} (${response.status})`)
      return (await response.json()) as Discovery
    }, rethrow)).catch((error: unknown) => {
      discovered = null
      throw error
    })

  let principal: Promise<string> | null = null
  /** This deployment's principal on the remote, asked once. */
  const self = () =>
    (principal ??= own
      .me()
      .then((me) => me.principal)
      .catch((error) => {
        principal = null
        throw error
      }))
  /**
   * A write's ID, from the one board() derived for it, under this deployment's own principal: the
   * remote takes a `key:<principal>:` ID only from that principal, so no one can post with it first.
   */
  const ownKey = async (derived: string) => keyId(await self(), derived)

  /** One protocol call on the remote, as `client`: the same route, with the input back on the wire. */
  async function call(client: BoardClient, method: Method, input: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const route = routes[method]
    // Each `:name` in the path is the input's field of that name; the rest are the query or the body.
    const fields = { ...input }
    const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
      const value = fields[name]
      delete fields[name]
      return encodeURIComponent(String(value))
    })
    let response: Response
    if (method === 'upload') {
      const { data, name, type } = input as Protocol['upload']['input']
      response = await client
        .request(path, {
          method: 'POST',
          body: data as Uint8Array<ArrayBuffer>,
          headers: { ...(type ? { 'content-type': type } : {}), ...(name !== null ? { 'x-board-filename': encodeURIComponent(name) } : {}) },
          signal,
        })
        .catch(rethrow)
    } else if (route.method === 'GET') response = await client.request(`${path}${queryString(fields)}`, { signal }).catch(rethrow)
    else
      response = await client
        .request(path, { method: 'POST', body: new TextEncoder().encode(JSON.stringify(fields)), headers: { 'content-type': 'application/json' }, signal })
        .catch(rethrow)
    if (response.ok) return response
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      if (body.error?.message) throw new HttpError(response.status, body.error.code ?? 'error', body.error.message)
    } catch (error) {
      if (error instanceof HttpError) throw error
    }
    throw new HttpError(502, 'remote_error', `${remote} answered ${response.status}`)
  }

  const methods = Object.fromEntries(
    METHODS.map((method) => [
      method,
      async (caller: Caller, input: Record<string, unknown>, signal: AbortSignal) => {
        const registering = start()
        const client = clientOf(caller)
        // Sync's records name its entries, which the board it uses knows from its registration.
        if ('self' in caller && caller.origin.via?.kind === 'engine') await registering
        // A post or schedule board() gave an ID derived from a trigger: the remote takes it as this
        // deployment's key, and a retry's lookup asks for the same.
        if ((method === 'post' || method === 'posted' || method === 'schedule') && 'self' in caller && typeof input.id === 'string' && DERIVED_ID.test(input.id))
          input = { ...input, id: await ownKey(input.id).catch(rethrow) }
        const response = await call(client, method, input, signal)
        return method === 'attachment' ? attachmentOf(String(input.id), response) : response.json()
      },
    ]),
  ) as unknown as ProtocolMethods

  /** Only an https URL can be woken; anything else pulls on its own. */
  const wakeable = (here: string | null) => (here?.startsWith('https://') ? here : null)

  let last: { url: string | null; at: number; result: RegistrationView } | null = null
  let registering: Promise<RegistrationView> | null = null
  /** Registers this board's watchers with the remote, as itself, replacing its last registration. */
  async function register(here: string | null): Promise<RegistrationView> {
    const current = await watchersHash()
    if (last && last.url === here && last.result.hash === current && Date.now() - last.at < REGISTER_EVERY_MS) return last.result
    registering ??= own
      .register({ url: here, watch: specs, ...(sync.length > 0 ? { sync } : {}) })
      .then((result) => {
        last = { url: here, at: Date.now(), result }
        return result
      })
      .finally(() => {
        registering = null
      })
    return registering
  }

  /** Runs one match and acks it: done, its error, or a skip for a watcher this board no longer has. */
  async function runOne(match: MatchView) {
    let outcome: { error?: string; skip?: boolean } = {}
    if (!bound().subscriptions[match.watcher]) outcome = { skip: true }
    else
      try {
        await bound().run(match.watcher, match.event, { trigger: `watch:${match.watcher}:${match.id}`, attempt: match.attempt + 1 })
      } catch (error) {
        console.error(`[vboard] watcher ${match.watcher} failed:`, error)
        outcome = { error: describe(error) }
      }
    // A lease that ran out was pulled again: that pull's ack is the one that counts.
    await own.ack(match.id, { lease: match.lease, ...outcome }).catch((error) => console.error(`[vboard] couldn't ack a match:`, describe(error)))
  }

  /**
   * Pulls and runs what's matched until nothing's left, or this run's time is up, and what sync
   * queued in its inbox. A thread's matches come one at a time.
   */
  async function drain(): Promise<number> {
    let ran = 0
    const until = Date.now() + DRAIN_MS
    while (Date.now() < until) {
      const matches = await own.matches({ limit: 10 })
      if (matches.length === 0) break
      // Each is a different watcher's or thread's oldest, so they run side by side.
      await Promise.all(matches.map(runOne))
      ran += matches.length
    }
    // An inbox event whose wait after an error is over: what woke this board may be it.
    return ran + (await bound().pull())
  }

  let polling: AbortController | null = null
  /** For a board that can't be woken: pulls on its own, each pull held open until something matches. */
  function poll() {
    if (polling) return
    const controller = (polling = new AbortController())
    void (async () => {
      for (let pause = 1000; !controller.signal.aborted; ) {
        try {
          await register(null)
          const matches = await own.matches({ limit: 10, wait: POLL_WAIT_S, signal: controller.signal })
          await Promise.all(matches.map(runOne))
          // Sync's inbox too: an event that failed tries again once its wait is over.
          await bound().pull()
          pause = 1000
        } catch (error) {
          if (controller.signal.aborted) break
          console.error(`[vboard] couldn't pull matches from ${remote}:`, describe(error))
          await new Promise((resolve) => setTimeout(resolve, pause))
          pause = Math.min(pause * 2, 60_000)
        }
      }
    })()
  }

  let started: Promise<void> | null = null
  /**
   * On first use, a board with watchers or sync registers them if it knows its URL. One on Vercel
   * learns its mount path from a request (a `POST /watchers`, a webhook, or a wake-up); one that
   * can't be woken registers without one and pulls instead. Resolves once the first try is done.
   */
  function start(): Promise<void> {
    if (started) return started
    if (Object.keys(specs).length === 0 && sync.length === 0) return Promise.resolve()
    const here = wakeable(bound().url())
    if (!here && process.env.VERCEL === '1') return Promise.resolve()
    started = register(here).then(
      () => {},
      (error: unknown) => console.error(`[vboard] couldn't register with ${remote}:`, describe(error)),
    )
    if (!here) poll()
    return started
  }

  const routesHere: BackendRoute[] = [
    {
      // The board it uses is what a handle here asks about; anyone else gets nothing to go on.
      method: 'GET',
      path: '/',
      auth: false,
      async handle(_request, { caller }) {
        if (!caller) throw servesOnly()
        return json(await discovery())
      },
    },
    {
      // Nothing in a wake-up is trusted: it only says to pull, and what's pulled comes with this board's own credentials.
      method: 'POST',
      path: '/wake',
      auth: false,
      async handle(request) {
        started ??= Promise.resolve()
        if (request.headers.get('x-board-watchers') !== (await watchersHash())) await register(wakeable(bound().url())).catch(rethrow)
        return json({ ran: await drain().catch(rethrow) })
      },
    },
    {
      // Anyone may ask: it sends this board's own watchers, with this board's own credentials. A
      // handle here registers its own, on the board it uses, as the protocol's route does.
      method: 'POST',
      path: '/watchers',
      auth: false,
      async handle(request, { caller }) {
        if (caller) return json(await methods.register(caller, RegisterBody.parse(await request.json()), request.signal))
        started ??= Promise.resolve()
        const here = wakeable(bound().url())
        const registration = await register(here).catch(rethrow)
        if (!here) poll()
        return json(registration)
      },
    },
  ]

  const backend = {
    ...methods,
    // What a caller may do is the board it uses' to say: requests here are only wake-ups.
    issuers: [],
    routes: routesHere,
    bind(next: BoardBinding) {
      if (binding) throw new Error('http: this backend already serves a board: create one http() per board()')
      for (const [id, spec] of Object.entries(next.subscriptions)) {
        // Sync subscribes as itself, beside the watchers: the remote sends it what it may sync.
        if (spec.kind === 'sync') {
          if (id === SYNC) sync = next.sync.map((entry) => ({ ...entry }))
          continue
        }
        if (!PROFILE.test(id)) throw new Error(`watch ${id}: ${PROFILE_RULE}`)
        if (!environment) throw new Error(`watch ${id}: watchers run on a server: this build of vboard has none`)
        environment.checkWatcher(id, spec)
        specs[id] = { tail: spec.tail, when: spec.when }
      }
      hash = null
      binding = next
    },
    /** Registers this board's watchers with the board it uses now, as `POST /watchers` does. */
    registerWatchers: () => register(wakeable(bound().url())),
    /** Stops pulling, for a board that pulls on its own. */
    close: () => {
      polling?.abort()
      polling = null
    },
  }
  return backend satisfies Backend
}

export type HttpBackend = ReturnType<typeof createHttp>
