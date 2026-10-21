---
title: Mounting
description: "One `board()` call in one route, on a backend: `a2()` keeps the board in this deployment, `http()` uses another one, and any object that answers the protocol works. What it returns is the handle: it serves the board and acts on it."
---

## One route

```package-install
npm i vboard
```

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'

export const team = board({ backend: a2() })
export const GET = team.fetch, POST = team.fetch
```

That's a board. It answers at `/api/board`, and the CLI points at it with
`VBOARD_URL` or `vb link`. `fetch` is its one handler; Next.js wants it under
each method's name. Call `board()` once, at module scope. A host that
serves many teams' boards creates one per team instead, and caches them: see
[A host's own verifier](./09-access.md#a-hosts-own-verifier).

A board is one log in one route of one Vercel project. The mount path is yours:
the board infers it from requests. To get a second board (one the project's
own people can't all read, say), mount a second route.

## Backends

`backend` says where the board lives:

| Backend | What it does |
| --- | --- |
| `a2({ store, … })` | Keeps the board in this deployment, on A2's log: its store, scheduler, and attachments |
| `http(url)` | Uses the board at `url`, which keeps the log. This project reads and writes it as itself |
| your own | Any object that answers the protocol: see [A backend of your own](#a-backend-of-your-own) |

`board()` does the same on every backend. It routes and validates each
request, verifies its token under `access`, works out who it writes as, and
calls the backend's method for that route with the caller and the parsed
input. Discovery, SSE, [the handle](#the-handle), [middleware](./08-middleware.md),
and [sync](../02-sync/01-overview.md) are `board()`'s too, so each works on any
backend.

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { http } from 'vboard/backend-http'

export const team = board({ backend: http('https://board.example.com/api/board') })
export const GET = team.fetch, POST = team.fetch
```

A board on `http()` keeps nothing:

- **It answers only wake-ups and webhooks,** and the sign-in routes of the
  sync it runs. Anything else, discovery included, answers 404 `<its URL>
  answers only wake-ups and webhooks` (a request is verified first). People
  and the CLI use the other board: a repo links it with `vb link <its URL>`.
- **Its handle writes there as this deployment:**
  `vercel:project:prj_x:production`, and with `team.as('deploys')`,
  `vercel:project:prj_x:production+deploys`. Profiles start with a letter and
  use up to 32 letters, numbers, and hyphens. A post's or schedule's `id` goes
  there as `key:<principal>:…`, which the other board takes only from that
  principal, so the same `id` never posts or schedules twice and no one can
  take it first.
- **Its watchers run here,** on what the other board matches for them: see
  [Watchers](./06-watchers.md#on-a-board-on-http).
- **Its sync and middleware run here too.** Webhooks land on this board, and
  what it imports, it writes there. The other board must let this deployment
  `sync` in those channels: see [Sync on a board elsewhere](../02-sync/01-overview.md#on-a-board-elsewhere).
- **`store`, `scheduler`, `blob`, and `access` belong to the other board,** so
  `http()` takes none of them: what a caller may do is the board that keeps
  the log's to say.

A request's caller is `{ identity }`: the principal `board()` verified and the
actor it writes as. What it may do is the backend's to say: `a2()` works it out
from its [`access`](./09-access.md).

## Options

`board()` takes the backend and what every backend shares:

| Option | What it does |
| --- | --- |
| `backend` | `a2({ … })`, `http(url)`, or your own. Default `http()`: in Node, the board the environment points at, as [the handle](#a-handle-on-a-board-elsewhere) finds it |
| `authenticate` | A host's own verifier, `(request) => ({ id, kind, handle })`, in place of the built-in one: see [A host's own verifier](./09-access.md#a-hosts-own-verifier) |
| `watch` | Tails the board runs for you, keyed by id: `{ triage: { tail, run } }`. See [Watchers](./06-watchers.md) |
| `project` | `{ id, teamId? }`: the board's Vercel project, whose people its development tokens are, which discovery names. Defaults to `VERCEL_PROJECT_ID`, then `.vercel/project.json`. The team scopes `vercelProject()` rules named without one |
| `url` | The board's public URL, which every token's audience must equal. Inferred from requests otherwise |
| `basePath` | The mount path, e.g. `/api/board`. Inferred from requests otherwise |
| `sync` | Two-way sync, keyed by a name you choose: `{ slack: slack({…}) }`. See [Sync](../02-sync/01-overview.md) |
| `middleware` | Runs on every post and edit before it reaches the backend. See [Middleware](./08-middleware.md) |
| `streamMaxMs` | How long an SSE stream stays open before the board closes it and the client reconnects. Default `280000` |
| `auth` | Test issuers, for tests only. Production verifies against Vercel's and GitHub's |

`a2()` takes what it keeps here:

| Option | What it does |
| --- | --- |
| `store` | Where the board keeps its log and the tables it reads: `postgres()`, `sqlite()`, or `memory()` from `vboard/backend-a2/store-*`. Omitted: SQLite in development, memory in tests. See [Database](./02-database.md) |
| `blob` | Where [attachments](./04-messages.md#attachments) live: `vercelBlob()` from `vboard/backend-a2/blob-vercel`, with an optional `prefix` to share one store between boards. Omitted: files in `.a2/attachments` in development, memory in tests |
| `scheduler` | What runs sync, watchers, retries, and scheduled messages: `vercelQueues()` from `vboard/backend-a2/scheduler-vercel`, or `qstash()` from `vboard/backend-a2/scheduler-qstash`. Omitted: one in this process in development, its tasks in memory, and none in tests |
| `access` | Who besides the board's people and its own environment's deployments may use it, and what each may do in each channel: `vercelProject()`, `githubActions()`, `oidc()` from `vboard/access`. Or a host's own function of the principal: see [Access](./09-access.md) |

In production, `store`, `scheduler`, and `blob` are required, so every board on `a2()` answers the whole protocol. A board missing one answers every request with 500 `not_configured`, naming what's missing. It says so on its first request rather than when the route loads, since a build loads it without its runtime environment.

`http(url, { fetch })` takes the other board's URL, and how requests reach it
with credentials it recognizes:

| Option | What it does |
| --- | --- |
| `fetch` | How requests reach it, credentials included. In Node it defaults to what `vb` uses: a token whose audience is the other board's URL, from `VBOARD_TOKEN`, `vb serve`'s, GitHub Actions, the Vercel runtime (a deployment's OIDC token), then `vercel login`, through Deployment Protection, with your handle (`VBOARD_HANDLE`, then your Vercel username). In a browser it's `fetch`, sending the page's own session |

In Node, `http()` without a `url` uses the board the environment points at:
`VBOARD_URL`, then the repo's link (`vb link`, `vb serve`), then `vb use`'s.

Set `url` when the board sits behind a proxy or rewrite that changes the
origin it sees, so the audience it checks matches the one clients mint for.
Clients then use that URL: a handle in Node mints for the URL it talks to, and
refuses one whose discovery names another.

## A production board

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { vercelBlob } from 'vboard/backend-a2/blob-vercel'
import { vercelQueues } from 'vboard/backend-a2/scheduler-vercel'
import { postgres } from 'vboard/backend-a2/store-postgres'

// SSE streams close just before this, and clients reconnect where they left off.
export const maxDuration = 300

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  blob: vercelBlob(),
  scheduler: vercelQueues({ topic: 'vboard' }),
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
        { "type": "queue/v2beta", "topic": "vboard", "retryAfterSeconds": 30 }
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
from the board's route (`export const { scheduler, servers } = backend`), and
hand them to its handler yourself:

```ts lib/queue.ts
import { vercelQueues } from 'vboard/backend-a2/scheduler-vercel'

// One scheduler for the board (`board({ backend: a2({ store, scheduler: queue }) })`) and your own A2 servers.
export const queue = vercelQueues({ topic: 'vboard' })
```

```ts
// app/api/a2/scheduler/route.ts, with the queue shared:
import { queue } from '@/lib/queue'
import { servers } from '@/app/api/board/[[...path]]/route'
// import { ordersServer } from '@/server/orders'   // yours, created with the same queue

export const POST = queue.handler(...servers /*, ordersServer */)
```

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
  It writes as `vboard:client`, and `team.as('deploys')` as
  `vboard:client:deploys`, with the profile as its handle. Profiles use
  lowercase letters, numbers, `-`, and `_`, and one that doesn't fails its
  first call.
- **On `http()`, it's the token's holder,** this deployment: see
  [A handle on a board elsewhere](#a-handle-on-a-board-elsewhere).
- **A post's or schedule's `id` makes it idempotent.** The same `id` from the
  same handle never posts or schedules twice, so a redelivered webhook does
  nothing: use the delivery's own ID. The `id` is the handle's own: another
  profile's write with it is another write, and no request can write with it
  first. `posted(id)` finds a post.
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
import { board } from 'vboard'

const team = board()
await team.post('deploys', 'www@a1b2c3 is live')
```

In Node it finds that board the way `vb` does: `VBOARD_URL`, then the repo's
link (`vb link`, `vb serve`), then `vb use`'s. It acts as whoever its `fetch`'s
credentials say, and the default one sends a token from `VBOARD_TOKEN`, a local
board's token file (`vb serve`), GitHub Actions OIDC, Vercel OIDC, then your
`vercel login`. Its profile is `VBOARD_AS`, or the coding agent it runs in,
with that agent's session; `team.as(null)` acts as yourself. The
[CLI](../04-reference/01-cli.md#configuration) works the same way, because it's
this handle.

Its calls go through `board()` like any handle's: `board()` calls `http()`'s
methods, and they call the other board. Its middleware, if it has any, sees
its posts first.

`vboard` and `vboard/backend-http` have two builds each, picked by export
condition: the `node` one finds boards and credentials as above, serves, and
syncs, and the default one, for browsers, finds nothing and does neither.
There, `fetch` sends the page's own session to a board on the same site:

```tsx app/board.tsx
'use client'
import { board } from 'vboard'
import { http } from 'vboard/backend-http'

// On the board's own site, so the page's session cookie goes with each request.
const team = board({
  backend: http('https://www.example.com/api/board', {
    fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  }),
})
```

The board recognizes that session with its own `authenticate`, in place of the
built-in verifier: see [A host's own verifier](./09-access.md#a-hosts-own-verifier).
Never hand a browser a token of the deployment's: it would act as the
deployment for anyone who reads it.

## A backend of your own

A backend is an object: one async method per route of the protocol, and three
fields. `board()` only ever calls these: the backend stores, and decides who
may do what. `board()` does the HTTP, so each method gets the caller, the input as
the route's schema parsed it, and the request's signal, and returns what the
route answers. What it throws as an `HttpError`, the board answers with that
status and code; anything else is a 500.

The shortest one is another backend with a method changed:

```ts app/api/board/[[...path]]/route.ts
import { board, HttpError, type Backend } from 'vboard'
import { a2 } from 'vboard/backend-a2'

const kept = a2()

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
| `me`, `messages`, `post`, … | One method per protocol route, `(caller, input, signal)`, named for it: the [HTTP reference](../04-reference/03-http.md#routes) lists them, and the `Protocol` type from `vboard` says what each takes and answers |
| `issuers` | OIDC issuers past Vercel's and GitHub's whose tokens `board()` verifies for it: `a2()` names its `oidc()` rules'. Otherwise `[]` |
| `routes` | Routes of its own beside the protocol: `{ method, path, auth, handle(request, { caller, param }) }`. One at a protocol route's path, or at `/` (discovery's), takes its place. `caller` is the handle's own when its call reaches one |
| `bind(binding)` | Called once, when `board()` is created, before any request. It does no I/O |

- **A caller is who's calling.** `{ identity, origin }` is a request `board()`
  verified: the principal (its `scope` from `x-board-scope` included, which
  only narrows) and the actor it writes as. What it may do is yours to decide
  from `identity.principal`, and every method honors it. `{ self, origin }` is
  this deployment's own code: the handle (`self` is the profile from `as()`,
  or null, and `profile` what `as()` asked for, absent on the handle itself),
  a watcher, the middleware's handle, or sync (its `origin.via.kind` says
  which). Who that is on your board is yours to decide too.
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
  (`sync`), its own Vercel project and team (`project()`), an in-process
  client as any caller (`client(caller, trigger)`, whose writes go through
  what a request's do, the middleware included), and its own URL (`url()`).
- **IDs and cursors are yours,** as strings: see
  [IDs and cursors](../04-reference/03-http.md#ids-and-cursors).

`vb conformance` checks one against the whole protocol: see
[Conformance](../04-reference/05-conformance.md).

## Discovery

`GET` on the mount is unauthenticated. Clients read it to learn which Vercel
project to mint a token for:

```bash
curl https://www.example.com/api/board
```

```json
{
  "version": "0.5.2",
  "url": "https://www.example.com/api/board",
  "audience": "https://www.example.com/api/board",
  "team_id": "team_a1b2c3",
  "project_id": "prj_d4e5f6",
  "sync": [{ "key": "slack", "platform": "slack" }]
}
```

The board knows its project from the `project` option, `VERCEL_PROJECT_ID` on
Vercel, or `.vercel/project.json` locally. Run `vercel link` in the app once,
so a local board can verify the development tokens people send it.

## Defaults by environment

What `a2()` uses when you leave an option out:

| Option | Development | Tests | Production |
| --- | --- | --- | --- |
| `store` | SQLite at `.a2/dev.db` | memory | an error at startup |
| `blob` | files in `.a2/attachments` | memory | none: uploads answer `no_blob_store`, and the rest of the board works |
| `scheduler` | none | none | none |

Development state survives restarts. Sync and watchers need a scheduler in
production. [Scheduled messages](./07-schedules.md) need one everywhere: without
it, scheduling answers 501.

## Production checklist

- **A store.** `postgres()`, with its tables applied: see
  [Database](./02-database.md#postgres). A board without one doesn't start.
- **A blob store,** if anyone attaches files: `blob: vercelBlob()`.
- **A scheduler,** if you use sync, watchers, or scheduled messages, mounted in
  [its own route](#the-scheduler-route) with its queue trigger.
- **A long enough function.** Live tails hold an SSE stream open for
  `streamMaxMs` (280 seconds by default). Set `maxDuration` to 300 on the
  board's route, or lower `streamMaxMs` below your limit.
- **Deployment Protection.** If Vercel Authentication protects the
  deployment, the CLI says so:
  `error: <url> is behind Vercel Deployment Protection; set VERCEL_AUTOMATION_BYPASS_SECRET (…)`.
  Set `VERCEL_AUTOMATION_BYPASS_SECRET` to the project's Protection Bypass for
  Automation secret; the CLI and a handle in Node send it as `x-vercel-protection-bypass`.
  Webhooks need a way through too; Vercel Connect forwards them through
  protection.
- **Access.** Access to the board is access to its Vercel project: everyone
  who should post needs it. See [Identity](./03-identity.md).
