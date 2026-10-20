import { createHash } from 'node:crypto'
import { DeliveryBody, type BoardEventView, type Discovery, type RegistrationView } from '../api/routes.ts'
import type { BoardClient } from '../client/client.ts'
import { createClient } from '../client/node.ts'
import { RemoteWatcherId } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import { createVerifier, vercelProject } from './auth.ts'
import type { BoardOptions } from './board.ts'
import { forbidden, HttpError, json, notFound, toErrorResponse, unauthorized } from './errors.ts'
import { discoveryIdentity } from './identity.ts'
import { watchersHash, type WatcherSpec } from './registry.ts'
import { readJson, route } from './routing.ts'
import { transport } from './transport.ts'
import { compileWatcher } from './watch.ts'

/** What a board with a remote can't have: each is the remote's. */
const THE_REMOTES = ['store', 'scheduler', 'blob', 'sync', 'middleware', 'access'] as const

/** A watcher's or client's name on a board with a remote is the profile its writes are by. */
function checkName(what: string, name: string) {
  const parsed = RemoteWatcherId.safeParse(name)
  if (!parsed.success) throw new Error(`${what} ${name}: ${parsed.error.issues[0]!.message}`)
}

/**
 * A post's ID on the remote, derived from what triggered it and its order, as an in-process
 * client's is. It isn't a UUIDv8, which the remote keeps for the writes it makes itself.
 */
const postId = (trigger: string, n: number) =>
  createHash('sha256').update(`vboard-remote\u001f${trigger}\u001f${n}`).digest('hex').slice(0, 32)

/** Registering again this soon after the same registration only repeats it. */
const REGISTER_EVERY_MS = 10_000

/** A board that keeps no log: it reads and writes `remote`, which delivers its watchers' matches to it. */
export function remoteBoard(options: BoardOptions & { remote: string }) {
  for (const key of THE_REMOTES)
    if (options[key] !== undefined) throw new Error(`a board with a remote keeps no log: \`${key}\` goes on the remote`)
  const remote = options.remote.replace(/\/+$/, '')
  const net = transport(options.transport)
  const watch = options.watch ?? {}
  const specs: Record<string, WatcherSpec> = {}
  for (const [id, watcher] of Object.entries(watch)) {
    checkName('watch', id)
    compileWatcher(id, watcher)
    specs[id] = { tail: watcher.tail, when: watcher.when ?? 'matches' }
  }
  const hash = watchersHash(specs)

  /** The SDK against the remote, as this deployment with `profile`. Posts get IDs derived from `trigger`. */
  function clientFor(profile: string | null, trigger: string | null): BoardClient {
    let posts = 0
    const doFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (trigger !== null && init.method === 'POST' && path.endsWith('/messages') && typeof init.body === 'string') {
        const body = JSON.parse(init.body) as Record<string, unknown>
        body.id ??= postId(trigger, posts++)
        init = { ...init, body: JSON.stringify(body) }
      }
      return net.fetch(input, init)
    }) as typeof fetch
    return createClient({
      url: remote,
      profile,
      session: null,
      handle: null,
      person: null,
      fetch: doFetch,
      // Otherwise the SDK finds one, as it would anywhere: on Vercel, the deployment's.
      ...(options.transport?.token ? { token: () => net.token(remote) } : {}),
    })
  }

  const registrar = clientFor(null, null)
  let last: { url: string; at: number; result: RegistrationView } | null = null
  /** This board's own principal on its remote, as its last registration came back. */
  let owner: string | null = null
  let registering: Promise<RegistrationView> | null = null
  /** Registers this board's watchers with its remote, as itself, replacing its last registration. */
  async function register(url: string): Promise<RegistrationView> {
    if (last && last.url === url && last.result.hash === hash && Date.now() - last.at < REGISTER_EVERY_MS) return last.result
    registering ??= registrar
      .register({ url, watch: specs })
      .then((result) => {
        last = { url, at: Date.now(), result }
        owner = result.owner
        return result
      })
      .finally(() => {
        registering = null
      })
    return registering
  }
  const tryRegister = (url: string) =>
    register(url).catch((error) => console.error(`[vboard] couldn't register this board's watchers with ${remote}:`, error))

  // Deliveries are signed by the remote's project, which its discovery names.
  let remoteProject: Promise<{ id: string; teamId: string | null }> | null = null
  const project = () =>
    (remoteProject ??= registrar
      .discovery()
      .then((found) => {
        if (!found.project_id) throw new HttpError(503, 'unavailable', `${remote} names no Vercel project, so its deliveries can't be checked`)
        return { id: found.project_id, teamId: found.team_id }
      })
      .catch((error) => {
        remoteProject = null
        throw error
      }))
  // Deliveries come from the remote's deployments in this board's own environment (production
  // when it runs in none): a production board never takes matches from its remote's previews.
  const { verify } = createVerifier({
    projectId: async () => (await project()).id,
    teamId: async () => (await project()).teamId,
    access: [vercelProject({ project: 'self', environments: [process.env.VERCEL_ENV || 'production'], can: 'all' })],
    ...(options.auth ? { auth: options.auth } : {}),
  })

  async function dispatch(request: Request): Promise<Response> {
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
            sync: [],
            remote,
          }
          return json(body)
        }
        case 'register':
          // Anyone may ask: it sends this board's own watchers, with this board's own credentials.
          return json(await register(boardUrl))
        case 'deliver': {
          const token = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1]
          if (!token) throw unauthorized('missing bearer token')
          const principal = await verify(token, boardUrl)
          // The remote's own deployments in this board's environment, not its previews.
          if (principal.kind !== 'deployment' || !principal.access.readsAll) throw forbidden(`deliveries come from ${remote}`)
          // Only matches this board registered: anyone can register a URL, and the remote then
          // sends them their matches there, which this board's watchers must never run on.
          const named = request.headers.get('x-board-owner')
          const own = owner ?? (await register(boardUrl)).owner
          if (named !== own) throw new HttpError(403, 'not_owner', `this delivery is for ${named ?? 'nobody'}'s registration, not this board's`)
          // The remote holds an older registration (a deploy changed the tails): bring it up to date,
          // even when the watcher this is for is gone, so the remote stops sending its matches.
          if (request.headers.get('x-board-watchers') !== hash) await tryRegister(boardUrl)
          const id = match.param!
          const watcher = watch[id]
          if (!watcher) throw notFound(`no watcher ${id} on this board`, 'no_watcher')
          const body = DeliveryBody.parse(await readJson(request))
          try {
            await watcher.run({ event: body.event as BoardEventView, board: clientFor(id, `watch:${id}:${body.id}`) })
          } catch (error) {
            console.error(`[vboard] watcher ${id} failed:`, error)
            const message = (error instanceof Error ? error.message : String(error)) || 'unknown error'
            throw new HttpError(500, 'run_failed', message.slice(0, 500))
          }
          return json({ ok: true })
        }
      }
      throw new HttpError(404, 'remote', `this board keeps no log: use ${remote}`)
    } catch (error) {
      return toErrorResponse(error)
    }
  }

  // A server that knows its URL registers when it starts. A function on Vercel starts
  // when something calls it, which is why a delivery or a `POST /watchers` also does.
  if (options.url) void tryRegister(options.url.replace(/\/+$/, ''))

  const handle = (request: Request) => dispatch(request)
  return {
    GET: handle,
    POST: handle,
    fetch: handle,
    /** A board with a remote has no scheduler: the remote runs everything. */
    scheduler: async () => toErrorResponse(notFound('this board keeps no log, so it has no scheduler: its remote runs everything')),
    servers: [] as never[],
    /**
     * A client for your own server code, writing to the remote as this deployment with `name`
     * as its profile. With a `key`, its posts are idempotent: the same key and order never post twice.
     */
    client(name: string, clientOptions: { key?: string } = {}): BoardClient {
      checkName('client', name)
      return clientFor(name, clientOptions.key === undefined ? null : `client:${name}:${clientOptions.key}`)
    },
    /** Registers this board's watchers with its remote now, as `POST /watchers` does. */
    register,
    remote,
  }
}
