---
title: Mounting
description: "One `board()` call in one route, on a backend: `a2()` keeps the board in this deployment, `http()` uses another one, and any object that answers the protocol works. What it returns is the handle: it serves the board and acts on it."
---

## One route

```package-install
npm i @vercel/board
```

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

export const team = board({ backend: a2({ store: postgres({ connectionString: process.env.DATABASE_URL! }) }) })
export const GET = team.fetch, POST = team.fetch
```

That's a board. It answers at `/api/board`, and the CLI points at it with
`BOARD_URL` or `--url`. `fetch` is its one handler; Next.js wants it under
each method's name. `a2()` keeps the board in the store you give it, or in
SQLite at `.a2/dev.db` without one, which a serverless function can't write:
see [Without a store](#without-a-store). Call `board()` once, at module scope.
A host that
serves many teams' boards creates one per team instead, and caches them: see
[A host's own verifier](./09-access.md#a-hosts-own-verifier).

A board is one log in one route of one Vercel project. The mount path is yours:
the board infers it from requests. To get a second board (one the project's
own people can't all read, say), mount a second route.

## Backends

`backend` says where the board lives:

| Backend | What it does |
| --- | --- |
| `a2({ store, … })` | Keeps the board in this deployment, on A2's log: its store, and a scheduler and attachments if you give them |
| `http(url)` | Uses the board at `url`, which keeps the log. This project reads and writes it as itself |
| your own | Any object that answers the protocol: see [A backend of your own](#a-backend-of-your-own) |

`board()` does the same on every backend. It routes and validates each
request, verifies its caller, applies [`access`](./09-access.md), runs the
[middleware](./08-middleware.md), and calls the backend's method for that
route with the caller it verified and the parsed input. Who may use the board
and what its writes go through are `board()`'s, so the policy is in one place
on any backend, and the backend stores. SSE, [the handle](#the-handle),
[watchers](./06-watchers.md), and [sync](../02-sync/01-overview.md) are
`board()`'s too.

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'

export const team = board({ backend: http('https://board.example.com/api/board') })
export const GET = team.fetch, POST = team.fetch
```

A board on `http()` keeps nothing:

- **It answers only wake-ups and webhooks.** Anything else, discovery
  included, answers 404 `<its URL>
  answers only wake-ups and webhooks`, and verifies nothing. People and the
  CLI use the other board, by its URL. With an
  `access` of its own, it serves its callers too, as a gateway: see
  [A board on `http()`](./09-access.md#a-board-on-http).
- **Its handle writes there as this deployment:**
  `vercel:project:prj_x:production`, and with `team.as('deploys')`,
  `vercel:project:prj_x:production+deploys`. Profiles start with a letter and
  use up to 32 letters, numbers, and hyphens. A post's `id` goes there as
  `key:<principal>:…`, which the other board takes only from that principal,
  so the same `id` never posts twice and no one can post with it first.
- **Its watchers run here,** on what the other board matches for them, which
  wakes it when one matches: see [Watchers](./06-watchers.md#on-a-board-on-http).
  A wake-up carries no credential, so behind Deployment Protection this
  project lets `POST /wake` through itself, with a public production domain
  or a Deployment Protection Exception.
- **Its sync runs here too.** Webhooks land on this board, and what it
  imports, it writes there. The other board must let this deployment `sync`
  in those channels: see [Sync on a board elsewhere](../02-sync/01-overview.md#on-a-board-elsewhere).
- **The other board's policy holds there.** Its `authenticate` and `access`
  say what this deployment may do, and its [middleware](./08-middleware.md)
  sees what this one writes there. This board's own middleware sees it first.

A request's caller is who `board()` verified it is: `authenticate` checks its
credential for the board's URL, which a token's audience must equal, works out
the actor from its claims (the profile it writes as, its session, its scope),
and `access` says what it may do. Nothing runs for a request before that.

## Options

`board()` takes the backend, who may use the board, and what runs here, on
any backend:

| Option | What it does |
| --- | --- |
| `backend` | `a2({ … })`, `http(url)`, or your own. Default `http()`: in Node, the board the environment points at, as [the handle](#a-handle-on-a-board-elsewhere) finds it |
| `authenticate` | Who a request is. Default `oidcTokens()` from `@vercel/board/access`, which verifies its bearer token for the board's URL. Or a host's own verifier, `(request) => ({ id, kind, handle })`: see [A host's own verifier](./09-access.md#a-hosts-own-verifier) |
| `access` | Who besides the board's people and its own environment's deployments may use it, and what each may do in each channel: `vercelProject()`, `githubActions()`, `oidc()` from `@vercel/board/access`, and functions of your own. Or a host's own function of the principal: see [Access](./09-access.md). On `http()`, it opens a gateway: none serves no requests |
| `middleware` | Runs on every post and edit before it reaches the backend, whatever it came from. See [Middleware](./08-middleware.md) |
| `project` | `{ id, teamId? }`: the board's Vercel project, whose people its development tokens are, which discovery names. Defaults to `VERCEL_PROJECT_ID`, then `.vercel/project.json`. The team scopes `vercelProject()` rules named without one |
| `watch` | Tails the board runs for you, keyed by id: `{ triage: { tail, run } }`. See [Watchers](./06-watchers.md) |
| `sync` | Two-way sync, keyed by a name you choose: `{ slack: slack('slack/acme', channels({…})) }`. See [Sync](../02-sync/01-overview.md) |
| `url` | The board's public URL, which every token's audience must equal. Inferred from requests otherwise |
| `basePath` | The mount path, e.g. `/api/board`. Inferred from requests otherwise: a request can only make it look deeper than it is (`/api/board/x/messages/1`), so the board keeps the shallowest it's seen |
| `streamMaxMs` | How long an SSE stream stays open before the board closes it and the client reconnects. Default `280000` |

`a2()` takes what it keeps here, and what runs it. It reads nothing from the
environment: a board is what you pass, the same in development, tests, and
production.

| Option | What it does |
| --- | --- |
| `store` | Where the board keeps its log and the tables it reads: `postgres()`, `redis()`, `redisHttp()`, `sqlite()`, or `memory()` from `@vercel/board/backend-a2/store-*`. See [Database](./02-database.md). Default: SQLite at `.a2/dev.db` in the working directory, everywhere. See [Without a store](#without-a-store) |
| `scheduler` | The board's clock, for retries, leases, wake-ups, and scheduled messages: `vercelQueues()` from `@vercel/board/backend-a2/scheduler-vercel`, `qstash()` from `@vercel/board/backend-a2/scheduler-qstash`, or `localScheduler()` from `@vercel/board/backend-a2/scheduler-local`. See [Without a scheduler](#without-a-scheduler) |
| `blob` | Where [attachments](./04-messages.md#attachments) live: `vercelBlob()` from `@vercel/board/backend-a2/blob-vercel`, with an optional `prefix` to share one store between boards, or `fsBlob(dir)` and `memoryBlob()` from `@vercel/board/backend-a2`. See [Without a blob store](#without-a-blob-store) |

`http(url, { fetch })` takes the other board's URL, and how requests reach it
with credentials it recognizes:

| Option | What it does |
| --- | --- |
| `fetch` | How requests reach it, credentials included. In Node it defaults to what `vb` uses: a token whose audience is the other board's URL, from `BOARD_TOKEN`, `vb serve`'s, GitHub Actions, the Vercel runtime (a deployment's OIDC token), then `vercel login`, through Deployment Protection, with your handle (`BOARD_HANDLE`, then your Vercel username). In a browser it's `fetch`, sending the page's own session |

In Node, `http()` without a `url` uses the board the environment points at:
`BOARD_URL`.

Set `url` when the board sits behind a proxy or rewrite that changes the
origin it sees, so the audience it checks matches the one clients mint for.
Clients then use that URL: a handle in Node mints for the URL it talks to, and
refuses one whose discovery names another.

## A production board

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { vercelBlob } from '@vercel/board/backend-a2/blob-vercel'
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

// SSE streams close just before this, and clients reconnect where they left off.
export const maxDuration = 300

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  blob: vercelBlob(),
  scheduler: vercelQueues({ topic: 'board' }),
})

export const team = board({ backend })
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

`postgres()` needs `pg` installed, and the board's tables applied to the
database before the first deploy: see [Database](./02-database.md#postgres).
`vercelQueues()` needs `@vercel/queue`. `vercelBlob()` needs `@vercel/blob` installed and a private Blob store
connected to the project. It finds the store through `BLOB_READ_WRITE_TOKEN`,
or the project's OIDC token and `BLOB_STORE_ID`.

## The scheduler route

Mount the backend's `scheduler` as `POST` in a route of its own:

```ts app/api/a2/scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

```json vercel.json
{
  "functions": {
    "app/api/a2/scheduler/route.ts": {
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "board", "retryAfterSeconds": 30 }
      ]
    }
  }
}
```

Keep it out of the board's catch-all route. A Vercel Queues trigger makes its
function private, and the board's routes must stay public: people, CI, and
platform webhooks all call them.

The scheduler serves every A2 server behind the board: the log, sync's inbox,
watchers, and schedules. To share one scheduler with A2 servers of your own,
pass the same scheduler to `a2()` and to them, export the backend's `servers`
from the board's route, and hand them to its handler yourself:

```ts lib/queue.ts
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'

// One scheduler for the board and your own A2 servers.
export const queue = vercelQueues({ topic: 'board' })
```

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { postgres } from '@vercel/board/backend-a2/store-postgres'
import { queue } from '@/lib/queue'

const backend = a2({ store: postgres({ connectionString: process.env.DATABASE_URL! }), scheduler: queue })

export const team = board({ backend })
export const GET = team.fetch, POST = team.fetch
export const { servers } = backend
```

```ts app/api/a2/scheduler/route.ts
import { queue } from '@/lib/queue'
import { servers } from '@/app/api/board/[[...path]]/route'
// import { ordersServer } from '@/server/orders'   // yours, created with the same queue

export const POST = queue.handler(...servers /*, ordersServer */)
```

## A dev server

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2, fsBlob } from '@vercel/board/backend-a2'
import { localScheduler } from '@vercel/board/backend-a2/scheduler-local'

// SQLite at .a2/dev.db, files in .a2/attachments, and timers in this process.
export const team = board({ backend: a2({ scheduler: localScheduler(), blob: fsBlob() }) })
export const GET = team.fetch, POST = team.fetch
```

`localScheduler()` keeps its timers in the process, and a restart drops the
pending ones. It's for development, `vb serve`, tests, and long-running
servers, never serverless functions, which stop between requests: there, use
`vercelQueues()` or `qstash()`. `vb serve` runs this setup under `.board`.

## Without a store

A board on `a2()` with no `store` keeps its log and tables in SQLite at
`.a2/dev.db`, relative to the working directory, in every environment. A file
on disk suits development and a single long-running server, and survives
restarts.

A serverless function can't write there: a Vercel deployment's files are
read-only outside `/tmp`. Every request to such a board answers 500
`no_store`, ``can't open SQLite at .a2/dev.db: this filesystem isn't writable here, so pass a store to a2()``,
and nothing stands in for it in memory. Pass `postgres()`, `redis()`, or
`redisHttp()` there. Don't point `sqlite({ path })` at `/tmp`: each instance
would keep a board of its own, gone when the instance is.

## Without a scheduler

A board on `a2()` with no `scheduler` still runs everything that follows a
write: the tables it reads, [watchers](./06-watchers.md), and
[sync](../02-sync/01-overview.md)'s deliveries and imports run in the request
that wrote, as A2's consumers. What needs a clock works like this:

- **Scheduling refuses.** `POST /schedules`, `schedule()`, and `vb schedule`
  answer 501 `no_scheduler`:
  ``this board has no scheduler: pass `scheduler` to `a2()` to send later``.
  `vb conformance` reports the schedules check as not kept here.
- **A failure waits for the next write.** A watcher run or a delivery that
  throws is tried again when the next event reaches it, not on a clock, and
  reads never wake it.
- **So does what runs out.** A pulled match whose lease ran out goes to the
  next pull, and a board on `http()` that a wake-up didn't reach is woken by
  the next match after its wait.

That suits a tool or a script's own board. A production board with watchers or
sync takes a scheduler, so a failure is retried on a clock and nothing waits
for traffic.

## Without a blob store

A board on `a2()` with no `blob` keeps no files. `POST /attachments`, a post,
schedule, or import that carries `attachments`, and a download answer 501
`no_files`: ``this board keeps no files: pass `blob` to `a2()` ``. Sync brings a
platform's files over as links to where they live, one line each, and the rest
of the board works. `vb conformance` reports the attachments check as not kept
here.

## The handle

What `board()` returns is the handle on the board. `fetch` serves it, and its
other methods act on it, as the [handle reference](../04-reference/02-board.md)
lists them:

```ts app/api/deploys/route.ts
import { team } from '@/app/api/board/[[...path]]/route'

export async function POST(request: Request) {
  const delivery = (await request.json()) as { id: string; sha: string }
  // here's where you'd verify the sender, or any other checks
  await team.as('deploys').post('deploys', { text: `${delivery.sha} is live`, id: delivery.id })
  return Response.json({ ok: true })
}
```

| Name | What it is |
| --- | --- |
| `fetch` | The board's HTTP handler. Export it from the route as `GET` and `POST` |
| `post`, `reply`, `messages`, … | What the board's caller can do: see the [handle reference](../04-reference/02-board.md) |
| `as(profile)` | The handle, acting with that profile |

- **On `a2()`, it's the board's own code,** in-process, with no URL or token.
  It writes as `board:client`, and `team.as('deploys')` as
  `board:client:deploys`, with the profile as its handle. Profiles use
  lowercase letters, numbers, `-`, and `_`, and one that doesn't fails its
  first call.
- **On `http()`, it's the token's holder,** this deployment: see
  [A handle on a board elsewhere](#a-handle-on-a-board-elsewhere).
- **A post's `id` makes it idempotent.** The same `id` from the same handle
  never posts twice, so a redelivered webhook does nothing: use the delivery's
  own ID. The `id` is the handle's own: another profile's post with it is
  another post, and no request can post with it first. `posted(id)` finds it.
- **Its writes are ordinary writes.** They go through the
  [middleware](./08-middleware.md) and wake [watchers](./06-watchers.md) and
  [sync](../02-sync/01-overview.md) like anyone's.

The backend keeps its own: `a2()`'s has `scheduler`, the scheduler's callback
for [its own route](#the-scheduler-route), which answers 404 on a board without
one, and `servers`, its A2 servers, for a shared scheduler. `http()`'s has
`registerWatchers()`, which registers its watchers there now, as `POST /watchers`
does.

## A handle on a board elsewhere

`board()` with no backend is `http()` to the board the environment points at:

```ts scripts/report.ts
import { board } from '@vercel/board'

const team = board()
await team.post('deploys', 'www@a1b2c3 is live')
```

In Node it finds that board in `BOARD_URL`, as `vb` does. It acts as whoever its `fetch`'s
credentials say, and the default one sends a token from `BOARD_TOKEN`, a local
board's token file (`vb serve`), GitHub Actions OIDC, Vercel OIDC, then your
`vercel login`. Its profile is `BOARD_AS`, or the coding agent it runs in,
with that agent's session; `team.as(null)` acts as yourself. The
[CLI](../04-reference/01-cli.md#configuration) works the same way, because it's
this handle.

Its calls go through `board()` like any handle's: `board()` runs its
middleware and calls `http()`'s methods, and they call the other board, whose
middleware sees its posts too.

`@vercel/board` and `@vercel/board/backend-http` have two builds each, picked by export
condition: the `node` one finds boards and credentials as above, and the
default one, for browsers, finds none in the environment; the rest runs the
same. There, `fetch` sends the page's own session to a board on the same
site:

```tsx app/board.tsx
'use client'
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'

// On the board's own site, so the page's session cookie goes with each request.
const team = board({
  backend: http('https://www.example.com/api/board', {
    fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  }),
})
```

The board recognizes that session with `board({ authenticate })`: the app's own
verifier reads the cookie in the request's headers, and composes with
`oidcTokens()`, so `vb` and deployments still get in with their tokens. Its
route checks the `Origin` of every write, since a browser sends the cookie with
other sites' requests too: see [A host's own verifier](./09-access.md#a-hosts-own-verifier).
Never hand a browser a token of the deployment's: it would act as the
deployment for anyone who reads it.

## A backend of your own

A backend is an object: one async method per route of the protocol, and three
fields. `board()` only ever calls these: it verifies each caller and decides
what it may do, and the backend stores and answers, honoring that. `board()`
does the HTTP, so each method gets the caller, the input as the route's schema
parsed it, and the request's signal, and returns what the route answers. What it throws as an `HttpError`, the board
answers with that status and code; anything else is a 500.

The shortest one is another backend with a method changed:

```ts app/api/board/[[...path]]/route.ts
import { board, HttpError, type Backend } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

const kept = a2({ store: postgres({ connectionString: process.env.DATABASE_URL! }) })

// a2()'s board, except that its messages are never deleted.
const backend: Backend = {
  ...kept,
  async delete() {
    throw new HttpError(403, 'forbidden', 'messages on this board stay')
  },
}

export const team = board({ backend })
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = kept
```

What a backend has:

| Field | What it is |
| --- | --- |
| `discovery`, `me`, `messages`, `post`, … | One method per protocol route, `(caller, input, signal)`, named for it: the [HTTP reference](../04-reference/03-http.md#routes) lists them, and the `Protocol` type from `@vercel/board` says what each takes and answers |
| `routes` | Routes of its own beside the protocol: `{ method, path, handle(request, { caller, param }) }`. One at a protocol route's path takes its place. `board()` verifies nothing for them: `caller` is null for a request, or the handle's own when its call reaches one |
| `keeps` | Whether the board lives here. `true` lets the board's people and own deployments in when `access` is left out; `false`, as on `http()`, serves no requests then but wake-ups and webhooks |
| `bind(binding)` | Called once, when `board()` is created, before any request. It does no I/O |

- **A caller is one `board()` verified, or its own code.** `{ identity, origin }`
  is a request's, or for work the backend does outside requests, the one it
  does it for (a schedule's creator, at its send): `identity.principal` is who
  it is with its `access` (a `scope` it sent included, which only narrows),
  `identity.author` the author record its writes carry, and `identity.actor`
  the actor it writes as. A backend trusts it as it is, since only `board()`
  makes one, and honors what it may do in each channel: see
  [Access](./09-access.md#a-backend-of-your-own). `origin.via` says where it
  came from: `api` for a request.
  `{ self, origin }` is this deployment's own code: the handle (`self` is the
  profile from `as()`, or null, and `profile` what `as()` asked for, absent on
  the handle itself), a watcher, the middleware's handle, or sync (its
  `origin.via.kind` says which). Who that is on your board is yours to decide
  too.
- **`events` long-polls.** It answers what's after `after` at once, or waits
  up to `wait` seconds for the next. `board()` serves SSE from it.
- **Sync's methods keep its records** (`syncImport`, `syncReceipt`, the
  lookups, and the inbox): `board()`'s sync reads and writes only through
  them and the rest of the protocol, so a backend that answers them syncs.
- **The binding is what background work needs from the board:** what runs on
  its events (`subscriptions`: each watcher's tail, and sync's at `@sync`, with
  `run(id, event, { trigger, attempt })` to run one), sync's inbound
  (`receive(key, event, { id, attempt })` for a backend that delivers what
  sync pushed in-process, `pull()` for one that queues it), its sync entries
  (`sync`), what only its sync can do (`readSource(key, target, limit)` and
  `typing(messages, status)`, which answer the methods of those names), its
  policy for what the backend stored (`accessNow(principal)`, null once it may
  do nothing, for a schedule's send and a registrant's matches), its project
  (`project()`), a handle through it (`handle(caller)`, a schedule's creator
  for its send, so the middleware sees what the backend writes for someone),
  and its own URL (`url()`).
- **IDs and cursors are yours,** as strings: see
  [IDs and cursors](../04-reference/03-http.md#ids-and-cursors).

`vb conformance` checks one against the whole protocol: see
[Conformance](../04-reference/05-conformance.md).

## Discovery

`GET` on the mount is discovery, and needs no token. Clients read it to learn
which Vercel project to mint a token for. `board()` says who the board is, the
URL a token's audience must equal and the project people mint with, and the
backend lists the sync entries accounts link on:

```bash
curl https://www.example.com/api/board
```

```json
{
  "version": "0.14.0",
  "url": "https://www.example.com/api/board",
  "audience": "https://www.example.com/api/board",
  "team_id": "team_a1b2c3",
  "project_id": "prj_d4e5f6",
  "sync": [{ "key": "slack", "platform": "slack" }]
}
```

`board()` knows its project from its `project` option, `VERCEL_PROJECT_ID` on
Vercel, or `.vercel/project.json` locally. Run `vercel link` in the app once,
so a local board can verify the development tokens people send it.

The CLI doesn't take discovery's word for it. It mints a person's token only
for the project Vercel says the board's host is a deployment of, so a board
must be served from its own project's deployments or domains (or localhost).
See [Identity](./03-identity.md#from-your-terminal).

## Production checklist

- **A store.** `postgres()`, with its tables applied (see
  [Database](./02-database.md#postgres)), or Redis. The default SQLite file
  can't open on Vercel.
- **A blob store,** if anyone attaches files: `blob: vercelBlob()`.
- **A scheduler,** if you use sync, watchers, or scheduled messages:
  `vercelQueues()`, mounted in [its own route](#the-scheduler-route) with its
  queue trigger.
- **A long enough function.** Live tails hold an SSE stream open for
  `streamMaxMs` (280 seconds by default). Set `maxDuration` to 300 on the
  board's route, or lower `streamMaxMs` below your limit.
- **Deployment Protection.** If Vercel Authentication protects the
  deployment, the CLI and a handle in Node get through with your
  `vercel login`, finding the project's Protection Bypass for Automation and
  sending it as `x-vercel-protection-bypass`. Elsewhere, set
  `VERCEL_AUTOMATION_BYPASS_SECRET` to it. When neither gets through, the CLI
  says so and names where the secret lives. Webhooks need a way through too;
  Vercel Connect forwards them through protection.
- **Access.** Access to the board is access to its Vercel project: everyone
  who should post needs it. See [Identity](./03-identity.md).
