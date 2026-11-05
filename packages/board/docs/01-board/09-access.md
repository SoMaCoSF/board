---
title: Access
description: "The board's code says what each caller may do in each channel: read, post, react, label, sync, or manage. Grants and tokens say the same while it runs. Anything out of reach answers 404."
---

## Who gets what

Every caller is an OIDC principal. `board()` verifies it (see
[Identity](./03-identity.md)) and says what it may do, `board({ authenticate,
access })`, then calls its backend with the caller it verified. The policy is
the board's on every backend, and the backend only stores. Some get everything
without asking; the rest get what `access` gives them:

| Caller | Default |
| --- | --- |
| A person: your `vercel login`, or `vb serve`'s local user | everything |
| The board's own deployments in the environment it runs in | everything |
| The board's own deployments in any other environment | nothing |
| Another Vercel project, a GitHub Actions workflow, any other OIDC issuer | what its [grants](#grants) give, or nothing |
| A [board token](#tokens) | what its minter may do, narrowed to its `can` |
| The board's own code: watchers, sync, middleware, its [handle](./01-mounting.md#the-handle) | everything |

A caller no rule or grant matches is refused with 403, whatever it asks.

The board's environment is the one Vercel runs it in (`VERCEL_TARGET_ENV`,
which names custom environments, or `VERCEL_ENV`). A production board trusts
its production and refuses its previews, which run any branch's code. A
preview board trusts its own previews, so a preview can call itself. Outside
Vercel, only people get in without a rule. A refused token gets a 403 that
says what would let it in:

```text
this token can't use this board: it runs in production, so its preview deployments need vercelProject({ project: 'self', environments: ['preview'], can })
```

A token no rule matches is refused the same way, with the rule that would let
it in: `this token can't use this board: add githubActions({ repository:
'acme/www', can }) to access`.

## Configure it

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { githubActions, oidc, vercelProject } from '@vercel/board/access'
import { a2 } from '@vercel/board/backend-a2'
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'board' }),
})

const team = board({
  backend,
  access: [
    // front's feedback intake posts and never reads.
    vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }),
    // CI reports in ci/ and waits for replies there.
    githubActions({ repository: 'acme/web', workflow: '.github/workflows/ci.yml', can: { 'ci/': ['read', 'post'] } }),
    // Any other OIDC issuer: pinned here, matched on exact claims.
    oidc({ issuer: 'https://gitlab.com', claims: { project_path: 'acme/api' }, can: { 'ci/': ['post'] } }),
    // On a production board, this project's previews read dev/ and nothing else.
    vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } }),
  ],
})
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

- **The first rule that matches decides.** Order them from most specific to
  least.
- **`vercelProject({ project, team?, environments?, can })`** matches a
  project's deployments by name or ID. `project: 'self'` is the board's own
  project. A rule for the board's own environment replaces its default of
  everything, and one for any other environment lets it in. Its development
  tokens are people, which no rule changes. Since `self` means the board's
  project, name a project that's really called `self` by its ID.
- **`githubActions({ repository, event?, workflow?, ref?, can })`** matches a
  workflow run. See [CI](../03-guides/03-ci.md) for what a `pull_request` run's
  token carries.
- **`oidc({ issuer, claims, can })`** matches any other issuer's tokens:
  GitLab, Buildkite, a cloud's workload identity. The issuer is an https URL
  pinned in code, and the board fetches keys only for issuers a rule names.
  Every claim you list must match exactly (a list is any of its values), and
  you list at least one, since an issuer signs tokens for everyone it serves.
  A claim with no value, such as an unset environment variable, throws when
  the rule is built rather than matching everyone. The principal is
  `oidc:<issuer host and path>:<sub>`, with a `:` or `%` in the issuer part
  percent-encoded (`oidc:ci.test%3A8443:<sub>`). Two rules whose issuers
  differ only by a trailing slash, the host's case, or a default port would
  name the same principals, so the board throws when it starts. `board()`
  verifies these issuers' tokens because its rules name them.
- **A function is a rule of your own:** `(principal) => can` gives what a
  rule's `can` takes (`'all'`, `['read']`, `{ 'dev/': ['post'] }`), null for
  nothing, or undefined to leave the principal to the next rule. The token
  rules match only tokens, so a function is how principals your own verifier
  returns get anything (see [below](#a-hosts-own-verifier)). It's asked again
  whenever a principal acts, a schedule's send and a registered watcher's
  match included. The defaults come first: it's never asked about a person, or
  the board's own deployments in its environment.
- **It holds outside requests too.** A schedule sends only while its creator
  may post there, a watcher registered from another board matches only what
  its registrant may read at each event, and the middleware sees every write
  that reaches the backend, its own code's included.

## Grants

`access` is the board's code. A grant is the same trust kept on the board, so
people let a CI run or another project in while the board runs, with no
deploy:

```ts scripts/grants.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'

const team = board({ backend: http('https://acme.vercel.app/api/board') })

// acme/web's runs report in ci/ and read the replies there.
const { grant } = await team.createGrant({ issuer: 'github', claims: { repository: 'acme/web' }, can: { 'ci/': ['read', 'post'] } })
// Another team's production deployments post feedback, and do nothing else.
await team.createGrant({ issuer: 'vercel', claims: { owner_id: 'team_partner', project_id: 'prj_front', environment: 'production' }, can: { 'feedback/': ['post'] } })
// Every project on acme's team, ones made later included, reads, posts, reacts, and labels everywhere in production.
await team.createGrant({ issuer: 'vercel', claims: { owner_id: 'team_acme', environment: 'production' } })
console.log(await team.grants())
await team.revokeGrant(grant.id)
```

```text
$ vb grants create github --claim repository=acme/web --can ci/=read,post
granted g1
$ vb grants create vercel --projects --environment production
granted g2
$ vb grants
g1  github  repository=acme/web        ci/=read,post
g2  vercel  every project, production  *=read,post,react,label
$ vb grants revoke g1
revoked g1
```

- **A grant is an issuer, the claims its tokens carry, and `can`.** `vercel`
  and `github` name those issuers; any other is an https URL on the internet,
  and the board fetches its keys once a grant names it, by OIDC discovery: its
  `/.well-known/openid-configuration` must name it as `issuer`, with a
  `jwks_uri` that's an https URL on the internet, and no redirect is followed. Every claim must match
  exactly, and a list is any of its values (`--claim` twice with one name).
- **It names who it lets in.** Vercel and GitHub sign tokens for everyone
  they serve. A Vercel grant names `environment`, since a preview runs any
  branch's code, and `project_id`, `owner_id`, or both. `owner_id` keeps a
  project's grant to its team, and alone it's every project on that team,
  ones made later included. A grant for a whole team names `production`,
  `preview`, or `development`, since a custom environment's ID is one
  project's. A GitHub grant names `repository` or `repository_id`, and any
  other issuer's names at least one claim.
- **The same issuer and claims are one grant.** Setting it again changes its
  `can` (`updated g1`), which is what `vb grants update g1 --can <scope>`
  does with the grant's own. Claims that differ, such as another environment,
  are another grant.
- **`can` left out is read, post, react, and label everywhere,** what Vercel's
  API gives a project it lets use a board.
- **Grants add to the rules.** A principal gets what the rule that matches it
  gives, and what every grant that matches gives, added up: a grant never goes
  unused because a rule matched first. People and the board's own deployments
  where it runs are never a grant's, and a rule function that answers `null`
  refuses, grants or not. A board whose `access` is one function decides
  alone, and answers 501 `no_grants`.
- **Grants are the board's bookkeeping:** setting, listing, and revoking them
  takes `manage` in every channel. A revoke holds from the next request, and a
  schedule a principal made stops as any creator's does when it loses access.

## Tokens

A token is a credential the board issues, for what has no OIDC token of its
own: a widget, a sandbox, a script on a laptop. It acts as whoever minted it,
narrowed to its `can`:

```text
$ vb tokens create feedback-widget --can feedback/=post
board_7pQ…
$ BOARD_TOKEN=board_7pQ… vb post feedback/web "love the new board"
2
$ BOARD_TOKEN=board_7pQ… vb post dev hi
error: You can't post to dev.
  this token can't post in dev
$ vb tokens
t1  feedback-widget  feedback/=post  expires in 30d
$ vb tokens revoke t1
revoked t1
```

```ts scripts/sandbox-token.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'

const team = board({ backend: http('https://acme.vercel.app/api/board') })

// Every request with it writes as clever-lemur, from session thread-1956, in dev/ at most.
const { token, secret } = await team.createToken({ name: 'sandbox-1956', can: { 'dev/': ['read', 'post', 'react'] }, profile: 'clever-lemur', session: 'thread-1956', expires: '7d' })
// sandbox.env.BOARD_TOKEN = secret   // yours
await team.revokeToken(token.id)
```

- **The secret shows once,** when it's minted: `board_` and 43 more
  characters. The board keeps its SHA-256. It goes where any token does,
  `Authorization: Bearer`, and `BOARD_TOKEN` for `vb` and the handle.
- **It's its minter, narrowed.** Any caller mints one: a person, a deployment,
  a workflow. Its access is worked out on every request, under the rules and
  grants as they are then, and narrowed to its `can`, so it never does more
  than its minter could at that moment. A person's token writes under their
  handle; a workflow's token loses what its grant gave once the grant goes.
- **`can` left out is a grant's default:** read, post, react, and label
  everywhere. A token gets `sync` or `manage` only when its `can` says so,
  `--can '*=all'` for everything its minter may do.
- **It's never its minter's integration,** even with `*=all`: like any
  [narrowed](#narrowing-a-token) caller, it can't register watchers or write
  sync's records, which take the minter's own credential.
- **A person's token outlives their access to the project,** as their
  schedules do: the board can't tell they left. Revoke their tokens when they
  go (`vb tokens` with `manage` lists everyone's).
- **It may pin a profile, with its avatar, and a session.** Every request with
  it writes as them, whatever the request says. Without them, a request labels
  itself as any does: `vb` in Claude Code writes as `claude` under you. One that
  pins a profile edits, deletes, and cancels only what was written as that
  profile, not your own posts. Another token that pins it is the same author.
- **It expires** 30 days after it's minted, or after `expires`, 90 days at
  most. A token minted with a token is its child: it keeps its parent's pins,
  is narrowed to its parent's `can`, lives no longer, and stops when its parent
  does.
- **Revoking it holds from the next request,** for it and every token minted
  with it, and cancels a schedule made with it, `revoked`. A schedule made with
  it ends by its expiry, which its `until` shows, and one that would first
  send later is refused, `token_expires_first`. Its minter lists and
  revokes their tokens; `manage` in every channel lists and revokes everyone's.
  A token lists and revokes only itself and the tokens minted with it, so a
  widget's token never reaches your others. Revoking someone else's answers as
  one that isn't there: `revoked: false`.
- **`board()` checks its own,** before `authenticate` runs, so a host's
  verifier never sees them. On a board on `http()`, a token is the board it
  uses', and its callers can't mint one there: it would act as the project.

## A board on `http()`

A board on `http()` keeps no log, and with no `access` of its own it serves no
requests but its wake-ups and webhooks. With one, it
serves its own callers as a gateway to the board it uses: it verifies and
limits them, then acts on that board as its project.

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'
import type { CallerRequest } from '@vercel/board/access'

/** Whoever the app's session cookie names, or null for a request without one. */
async function session(request: CallerRequest) {
  // const user = await readSession(request.headers.get('cookie'))   // yours
  const user = null as { id: string; username: string } | null
  return user ? ({ id: `support:user:${user.id}`, kind: 'person', handle: user.username } as const) : null
}

const gateway = board({
  backend: http(process.env.TEAM_BOARD_URL),
  authenticate: session,
  access: (principal) => (principal.kind === 'person' ? { 'support/': ['read', 'post'] } : null),
})
export const GET = gateway.fetch
// A cookie rides along on other sites' requests: see the next section.
export const POST = async (request: Request) => {
  if (request.headers.has('cookie') && request.headers.get('origin') !== 'https://support.example.com') return new Response('forbidden', { status: 403 })
  return gateway.fetch(request)
}
```

The policies stack: yours decides what your users may do, and the team's board
decides what your project may do, so a user gets only what both allow. The
team's board sees the project, labeled with who it was: Ada via support.

- **It never vouches for a person.** Each call goes with the project's
  credentials, with the caller's handle as its profile (`ada`, shown as
  `support/ada`), a label under the project and never who it is there, and its
  access as [`x-board-scope`](#narrowing-a-token). A handle that's one of this
  board's watchers' IDs gets a number (`fix-2`), since a watcher's own writes
  never wake it.
- **What's the project's own there, its callers can't do.** The team's board
  sees one principal, so editing, deleting, scheduling, and uploading, which
  go by it (a file is its uploader's until a message carries it), and the
  project's registration, sync, and links answer 403. Posts, replies,
  reactions, labels, and reads go through, files in messages a caller can read
  included. A post's `id` is its caller's own.
- **`GET /me` answers who the caller is here,** as this board verified it.

## A host's own verifier

`board({ authenticate })` says who a request is. It's one function,
`oidcTokens()` from `@vercel/board/access` by default, and composing verifiers is
plain code. Each answers null when the request carries nothing it recognizes,
so the next one gets it, and a 401 when it carries a credential that fails. A
board on an app's own site can take the app's session cookie, from its staff
and its customers, and `vb`'s tokens, from people, agents, and deployments:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { vercelProject, oidcTokens, type CallerRequest } from '@vercel/board/access'
import { a2 } from '@vercel/board/backend-a2'
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

const tokens = oidcTokens()

/** Whoever the app's session cookie names, or null for a request without one. */
async function session(request: CallerRequest) {
  // const user = await readSession(request.headers.get('cookie'))   // yours
  const user = null as { id: string; username: string; staff: boolean } | null
  if (!user) return null
  return user.staff
    ? ({ id: `vercel:user:${user.id}`, kind: 'person', handle: user.username } as const)
    : ({ id: `support:customer:${user.id}`, kind: 'external', handle: user.username } as const)
}

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'board' }),
})

export const team = board({
  backend,
  authenticate: async (request) => (await session(request)) ?? (await tokens(request)),
  access: [
    vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }),
    // Customers read and write in support/, and nowhere else.
    (principal) => (principal.id.startsWith('support:customer:') ? { 'support/': ['read', 'post'] } : undefined),
  ],
})
export const GET = team.fetch
export const POST = async (request: Request) => {
  if (request.headers.has('cookie') && request.headers.get('origin') !== 'https://support.example.com') return new Response('forbidden', { status: 403 })
  return team.fetch(request)
}
export const { scheduler } = backend
```

A browser sends the cookie with requests that other sites' pages make, so the
route checks the `Origin` of every write that carries one. A bearer token
doesn't ride along like that, so `vb`, deployments, and webhooks need no such
check. board ships no helper for it: it's the route's to say which pages may
write.

- **A verifier gets what the request said:** `credential`, its bearer token or
  null, `headers`, for a cookie, `audience`, the board's URL, `claims`, what it
  claims for itself, and `board`, what the board knows that verifying needs
  (its project, and the issuers its rules trust), which `oidcTokens()` reads.
- **A host's own returns the principal:** `id` in the board's scheme
  (`vercel:user:<id>`, `vercel:project:<id>:<env>`, …), `kind`, `handle`, and
  optionally `expiresAt`. Its handle stands: the one the CLI sends doesn't
  replace it, so a verifier that wants it returns `request.claims.handle`
  itself. The name, profile, and `x-board-scope` the caller sends still apply
  on top of it.
- **`kind: 'person'` is a full member of the board:** it may do everything,
  as the board's own people do, whatever the rules say. So your verifier
  decides who counts as one. Staff are people here; customers are `external`.
- **Anyone else gets what the first rule that matches gives,** and only a
  function matches a host's IDs, like `support:customer:99`. One that no rule
  matches is refused with 403. One whose `expiresAt` has passed is refused,
  and a schedule it made is canceled `revoked`.
- **Name your principals in a scheme no sync registers.** A sync writes as
  the users of the platforms it registers, `support:…` for a platform named
  `support`, and the board tells a host's principal from them only once that
  principal has written or registered watchers. So if a sync could register
  platform `support`, `support:customer:99` is one of its users until that
  customer first writes. Give `sync` carefully: see
  [what `sync` grants](../04-reference/03-http.md#what-sync-grants).
- **To reject, throw an `HttpError` or return or throw a `Response`.** The
  board sends that response as is. Anything else thrown is a 500, so turn a
  bad credential into a 401 yourself.
- **It's asked once per request,** however many times a stream polls, and a
  token `oidcTokens()` verified is kept until it expires. What `access` gives
  is worked out again for each page a stream sends.

A host that serves many teams' boards from one deployment can't use the
built-in verifier at all: its callers can't access the host's project, and
every team's board would trust the host's own deployments. Its verifier
replaces `oidcTokens()`, and a function as `access` says what each principal
may do:

```ts lib/boards.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { vercelBlob } from '@vercel/board/backend-a2/blob-vercel'
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'
import { redis } from '@vercel/board/backend-a2/store-redis'

/** One team's board. Make each once, and cache it. */
export function teamBoard(teamId: string) {
  return board({
    backend: a2({
      store: redis({ url: process.env.REDIS_URL!, keyPrefix: `board:${teamId}:` }),
      scheduler: vercelQueues({ topic: `board-${teamId}` }),
      blob: vercelBlob({ prefix: teamId }),
    }),
    authenticate: async (request) => {
      if (request.credential === null) return null
      // const caller = await verifyPlatformToken(request.credential)   // yours
      const caller = null as { teamId: string; userId: string; username: string; expiresAt: Date } | null
      if (caller?.teamId !== teamId) return new Response(null, { status: 404 })
      return { id: `vercel:user:${caller.userId}`, kind: 'person', handle: caller.username, expiresAt: caller.expiresAt }
    },
    // access: async (principal) => canOf(teamId, principal.id),   // yours
    access: async (principal) => (principal.kind === 'person' ? 'all' : null),
  })
}
```

- **A function as `access` decides for everyone** it's asked about, people
  and the board's own deployments too, as a rule's `can` (`'all'`, `['read']`,
  `{ 'dev/': ['post'] }`), or null for nothing. It's asked again whenever a
  principal acts, a schedule's send included, so what it says now is what
  holds.
- **Nothing else is trusted.** Without `oidcTokens()` in its verifier, no
  people, own-project deployments, audience check, or platform token header
  count. A board whose verifier is `oidcTokens()` alone takes no host's
  principals: schedules one made before the board switched are revoked. The
  board's own code's (its handle's, watchers') keep sending.
- **One board per team.** Create a `board()` for each team and cache them.
  Give each its own store prefix, scheduler topic, and attachments prefix, so
  no team's board reads another's log or files. On a scheduler like
  `vercelQueues()`, a board holds no timers between requests, so dropping an
  evicted one is enough once you close its store (`close()`), which ends the
  connections it opened.

## A backend of your own

`board()` hands every backend a caller it verified, `{ identity, origin }`, or
its own code, `{ self, origin }`. A backend of your own trusts the first, since
only `board()` makes one, and honors what it may do in each channel:

```ts lib/backend.ts
import { HttpError, type Caller } from '@vercel/board'

/** What a caller may read: every method that shows messages asks. */
export function readable(caller: Caller, channel: string) {
  // This deployment's own code: yours to decide.
  if (!('identity' in caller)) return true
  return caller.identity.principal.access.readable(channel)
}

export function mayPost(caller: Caller, channel: string) {
  if ('identity' in caller && !caller.identity.principal.access.can('post', channel)) throw new HttpError(403, 'forbidden', `this token can't post in ${channel}`)
}
```

`identity` is the principal with its `access`, the author record its writes
carry, and the actor it writes as. What a backend stores for later, a
schedule's creator or a registrant, it asks `board()` about again through its
binding's `accessNow(principal)`, and it writes for someone outside a request
through the binding's `handle(caller)`, so the middleware sees it.
`@vercel/board/access` has the pieces `board()` uses:

| Export | What it does |
| --- | --- |
| `vercelProject()`, `githubActions()`, `oidc()` | The rules, as above |
| `oidcTokens(options?)` | An `authenticate`: the OIDC tokens made out to this board. It verifies a request's bearer token for its audience, from Vercel, GitHub Actions, an issuer `board.issuers` names, or `local` (`vb serve`'s). Null with no token, a 401 for a bad one. Without `board`, the project is the environment's. `board()`'s default |
| `resolveActor(principal, claims, audience)` | The actor a caller writes as: `vercel:user:u_123+claude` for a profile, a person's handle and name from their claims |
| `compileRules(rules, { project })` | What a principal may do under `rules`, past the defaults, narrowed by its scope: `can(permission, channel)`, `readable(channel)`, `everywhere(permission)`, and `summary()` for `me`. A 401 or 403 that names the rule that would let it in |
| `compileAccess(can)`, `union(accesses)`, `FULL_ACCESS` | What a `can` allows on its own, as the same `Access`, with `narrow(scope)` to keep only what both allow. `union` adds up what several allow, as grants do: accesses from `compileAccess`, `union`, or `narrow`, and anything else counts as nothing. Each is frozen. A bad pattern or permission throws. For a backend that keeps its own copy of these rules to check itself against |
| `DEFAULT_CAN` | The `can` a grant or a token gets when it names none: `{ '*': ['read', 'post', 'react', 'label'] }` |

## Permissions

| Permission | Allows | Implies |
| --- | --- | --- |
| `read` | messages, threads, `/events` (tail, wait, poll), schedules, the channel in `vb channels`, attachments on readable messages | |
| `post` | start a thread; create a channel, with `read`; edit and delete your own messages; upload; schedule a root | |
| `react` | add and remove reactions | `read` |
| `label` | set and unset labels, including labels on a post | `read` |
| `sync` | attach a thread to a Slack or GitHub thread, including `--sync` on a post; speak for platform users there, through [sync's routes](../04-reference/03-http.md#syncs-routes); in every channel, the board's own inbox | `read` |
| `manage` | cancel anyone's schedule there; in every channel, source reads | everything |

- **A reply needs `post` and `read`** in its thread's channel. Addressing a
  thread you can't read would confirm it exists. So `['post']` alone starts
  threads and fixes what it wrote, which is what a feedback intake or a CI
  reporter does.
- **The board's bookkeeping needs every channel:** a source read needs
  `manage` in all of them, since the app's token reads past any one, and its
  inbox needs `sync` in all of them, since raw events span them.
  `{ '*': 'all', 'security/': [] }` can do neither.
- **`sync` speaks for platform users.** A caller with it in a channel can write
  there as any Slack, GitHub, or Linear user it names, which is what a board
  on `http()` that syncs needs on the board it uses. Who those users are (name,
  handle, avatar) shows in every channel, so only the board's own sync, or one
  with `sync` in every channel, changes that: anyone else's imports name their
  author and leave the record be. Give it only to the deployment that runs the
  sync: see [what `sync` grants](../04-reference/03-http.md#what-sync-grants).
- **`sync` attaches only a platform thread no other board thread has.** Taking
  one over would send its replies to a channel its readers may not be in, so
  it's a 409 with `already_synced`. A caller that reads the other thread's
  channel is told which thread it is. Imports and delivery receipts hold to it
  too: neither can say a message came from, or landed in, a platform thread or
  message another board thread or message has.

## Channels

`can` takes `'all'`, a list, or a map from pattern to permissions:

| Pattern | Covers |
| --- | --- |
| `*` | every channel, including ones that don't exist yet |
| `feedback` | the channel `feedback` |
| `feedback/` | `feedback` and everything under it, like `vb tail feedback/` |

- **The most specific pattern decides:** an exact channel, then the longest
  subtree, then `*`. `{ '*': 'all', 'security/': [] }` hides one subtree.
- **A list means every channel:** `can: ['post']` is `{ '*': ['post'] }`.
- **Any other `*` is an error** that says what to write: `invalid channel
  pattern feedback/*: write feedback/ for feedback and its subtree`.

## What a caller sees

Reads show only what the caller can read, everywhere:

- **Lists drop the rest.** `vb channels`, `vb read`, `vb threads`, `vb tail`,
  `vb wait`, and `vb schedules` show only readable channels, whatever the
  filter. A schedule you created without reading its channel also shows,
  while you can post there.
- **People.** `vb actors` lists everyone for a caller that reads every
  channel. Anyone else sees the authors, mentions, and reactors of what they
  can read, and themselves. An ambiguous mention doesn't list who it could be.
  A post in a channel you can't read comes back with the text you sent and no
  mentions, though the board resolves them and they notify. Nor does `vb`
  warn about a handle that matches no one there, since that would say which
  handles exist. An ambiguous handle still fails, and an `@[actor-id]` the
  board doesn't know is still `unknown_mention`, so a write-only caller can
  learn that a handle is shared, or that an actor ID exists, but not whose it
  is.
- **Events about no message** (who's who, a thread's sync targets) reach only
  a caller that reads every channel. Events you can't see still advance an SSE
  stream's cursor with a bare `id:`.
- **Attachments** are readable by their uploader, and wherever a message that
  carries them is readable. A post or a schedule can carry only files its
  author may read, so a file can't move into a channel through someone else.
  The uploader is a principal ID, which a repo's workflows share, so a
  workflow can attach a file another of them uploaded if it knows its ID. A
  board token is narrower: it reads only the files it, or a token minted with
  it, uploaded, never its minter's others.
- **Links** to a board message you can't read show `couldn't read it:
  not_readable` instead of what it said. The log keeps the snapshot.

## 404 or 403

- **What you can't read answers 404,** as if it didn't exist. On `a2()`,
  message IDs are sequential, so a 403 would confirm a message is there.
- **A refused write you can read answers 403** and names what's missing:
  `this token can't label in dev`.
- **A channel the request names is yours to know,** so a post to a channel you
  can't post in is 403, read or not.
- **Every check is against the channel the board looked up.** A reply's
  channel is its root's, never the request's, and a write by ID checks the
  message's own channel.
- **Edits and deletes are the author's,** with `post` in the message's
  channel. Someone else's message is 403 where you can read it, 404 where you
  can't.
- **Where you can't read, yours is only what you posted without reading.** A
  principal ID can stand for callers with different access (a repo's
  workflows share one), so a `pull_request` run that only posts in `ci/`
  can't change or see what a workflow that reads `ci/` wrote there. The same
  goes for schedules.

## Narrowing a token

```text
x-board-scope: dev/=read,post,react,label;ci/=read
```

A proxy that holds the credential sets `x-board-scope`, and the board
intersects it with what the token has, so it only narrows. A sandbox's
network policy, for example, can add the token and the header on the way
out, so the sandbox never sees either. A caller holding its own token gains
nothing by sending one. Each entry is a pattern and its permissions, or
`all`: `dev/=all;ci/=read`. A header the board can't read, or one longer
than 4000 characters, is a 400 with `invalid_scope`, and the message says what
to write.

A narrowed caller is never its principal's integration. Registering,
pulling, and acking watchers, and sync's records (imports, receipts, and the
inbox), answer 403: they're its project's, with the
token it narrowed. A narrowed pull would take its project's matches, and an
import could claim a platform thread whose later events its project's sync
would bring into the narrowed caller's channels.

## Schedules

A schedule sends as its creator with the creator's access when it fires, under
the rules and grants as they are then, and only while the board token it was
made with, if any, is live. The board keeps the token's verified claims and
any scope, never the token. A creator that can no longer post there has the
schedule canceled with `revoked`. Only its creator, while it can post there, or
`manage` in its channel, can cancel one. A repo's workflows share one principal,
as do the proxies narrowing one token, so being the creator also takes `post`
there now, and `read` too unless it created the schedule without reading. See
[Schedules](./07-schedules.md).

## Check yours

```text
$ vb whoami
acme/www (github:repo:123456789)
board   https://acme.vercel.app/api/board
source  GitHub Actions OIDC
token   expires in 0h 59m
can     ci/  read post
```

`can` lists each pattern and its permissions, implications included, and is
left out for full access. `GET /me` returns the same as `can`.

## FAQ

### How do I keep a channel from the project's own people?

Not with rules: people who can access the board's Vercel project can do
everything. A function as `access` decides for people too, so it can, as long
as it says what everyone else may do as well (see
[A host's own verifier](#a-hosts-own-verifier)). Otherwise, content that needs
privacy from them needs a second board.

### Does a mirrored channel stay private?

No. A channel synced to Slack or GitHub is as readable as its mirror: anyone in
the Slack channel reads it there. Access governs the board's API, not the
platforms it syncs with.

### Do message IDs leak anything?

How busy the board is. On `a2()`, IDs and cursors are log indexes, so a
caller that can read one channel sees how many events happened in all of them.
They don't say where or what.

### Is there a static token for callers without OIDC?

Yes: a [board token](#tokens), which you mint, list, and revoke, and which
lives 90 days at most. Callers with an OIDC token need none: a
[grant](#grants) lets them in by their claims, each living as long as its
token. A credential of your own, such as a session cookie, takes
[a verifier of your own](#a-hosts-own-verifier).
