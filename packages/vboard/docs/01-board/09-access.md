---
title: Access
description: "The board's code says what each caller may do in each channel: read, post, react, label, sync, or manage. Anything out of reach answers 404."
---

## Who gets what

Every caller is an OIDC principal, which `board()` verifies (see
[Identity](./03-identity.md)). What it may do is up to the board that keeps the
log: `a2({ access })`. Some get everything without asking; the rest get what
`access` gives them:

| Caller | Default |
| --- | --- |
| A person: your `vercel login`, or `vb serve`'s local user | everything |
| The board's own deployments in the environment it runs in | everything |
| The board's own deployments in any other environment | nothing |
| Another Vercel project, a GitHub Actions workflow, any other OIDC issuer | nothing |
| The board's own code: watchers, sync, middleware, `board.client()` | everything |

A caller no rule matches is refused with 403 before it reaches a route.

The board's environment is the one Vercel runs it in (`VERCEL_TARGET_ENV`,
which names custom environments, or `VERCEL_ENV`). A production board trusts
its production and refuses its previews, which run any branch's code. A
preview board trusts its own previews, so a preview can call itself. Outside
Vercel, only people get in without a rule.

```text
error: this token can't use this board: it runs in production, so its preview deployments need vercelProject({ project: 'self', environments: ['preview'], can })
```

A token no rule matches is refused the same way, with the rule that would let
it in: `error: this token can't use this board: add githubActions({ repository:
'basehub-ai/www', can }) to access`.

## Configure it

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { githubActions, oidc, vercelProject } from 'vboard/access'
import { a2 } from 'vboard/backend-a2'

const backend = a2({
  // store and scheduler as in Mounting
  access: [
    // front's feedback intake posts and never reads.
    vercelProject({ project: 'prj_front', can: { 'feedback/': ['post'] } }),
    // CI reports in ci/ and waits for replies there.
    githubActions({ repository: 'vercel/v0', workflow: '.github/workflows/ci.yml', can: { 'ci/': ['read', 'post'] } }),
    // Any other OIDC issuer: pinned here, matched on exact claims.
    oidc({ issuer: 'https://gitlab.com', claims: { project_path: 'acme/api' }, can: { 'ci/': ['post'] } }),
    // On a production board, this project's previews read dev/ and nothing else.
    vercelProject({ project: 'self', environments: ['preview'], can: { 'dev/': ['read'] } }),
  ],
})

export const { GET, POST } = board({ backend })
export const { scheduler } = backend
```

- **The first rule that matches a token decides.** Order them from most
  specific to least.
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
  verifies these issuers' tokens because `a2()` names them (its `issuers`).
- **A board on `http()` has no `access`.** The board that keeps the log decides
  what its callers may do there.

## A host's own verifier

A host that serves many teams' boards from one deployment can't use the
built-in verifier: its callers can't access the host's project, and every
team's board would trust the host's own deployments. Pass `authenticate` to
`board()` to say who a request is with your own credentials, and a function as
`a2({ access })` to say what they may do:

```ts
// const teamId = …, and verifyPlatformToken and canOf are yours
board({
  backend: a2({
    store: redis({ keyPrefix: `board:${teamId}:` }),
    scheduler: vercelQueues({ topic: `board-${teamId}` }),
    blob: vercelBlob({ prefix: teamId }),
    access: async (principal) => canOf(teamId, principal.id),
  }),
  authenticate: async (request) => {
    const caller = await verifyPlatformToken(request.headers.get('authorization'))
    if (caller?.teamId !== teamId) return new Response(null, { status: 404 })
    return { id: `vercel:user:${caller.userId}`, kind: 'person', handle: caller.username, expiresAt: caller.expiresAt }
  },
})
```

- **`authenticate` returns the principal:** `id` in the board's scheme
  (`vercel:user:<id>`, `vercel:project:<id>:<env>`, …), `kind`, `handle`, and
  optionally `expiresAt`. The handle, name, profile, and `x-board-scope` the
  caller sends still apply on top of it.
- **To reject, return or throw a `Response`.** The board sends that response
  as is. Anything else thrown is a 500, so turn a bad token into a 401 yourself.
- **`access` gives each principal what it may do,** as a rule's `can`
  (`'all'`, `['read']`, `{ 'dev/': ['post'] }`), or null for nothing. It's
  asked again whenever a principal acts, a schedule's send included, so what it
  says now is what holds. A schedule whose creator's `expiresAt` has passed is
  canceled `revoked`.
- **Nothing else is trusted.** With `authenticate`, no people, own-project
  deployments, audience check, or platform token header count, and with a
  function as `access`, only the principals `authenticate` returned get
  anything. Schedules made before a board switched to or from them are
  revoked; the board's own code's (`board.client()`, watchers) keep sending.
- **One board per team.** Create a `board()` for each team and cache them.
  Give each its own store prefix, scheduler topic, and attachments prefix, so
  no team's board reads another's log or files. A board holds no timers or
  connections between requests, so dropping an evicted one is enough; close
  the store client if you made one for it.

## Permissions

| Permission | Allows | Implies |
| --- | --- | --- |
| `read` | messages, threads, `/events` (tail, wait, poll), schedules, the channel in `vb channels`, attachments on readable messages | |
| `post` | start a thread; edit and delete your own messages; upload; schedule a root | |
| `react` | add and remove reactions | `read` |
| `label` | set and unset labels, including labels on a post | `read` |
| `sync` | attach a thread to a Slack or GitHub thread, including `--sync` on a post; speak for platform users there, through [sync's routes](../04-reference/03-http.md#syncs-routes); in every channel, the board's own inbox | `read` |
| `manage` | cancel anyone's schedule there; in every channel, stuck events, redrive, and source reads | everything |

- **A reply needs `post` and `read`** in its thread's channel. Addressing a
  thread you can't read would confirm it exists. So `['post']` alone starts
  threads and fixes what it wrote, which is what a feedback intake or a CI
  reporter does.
- **The board's bookkeeping needs `manage` in every channel,** since stuck
  events span all of them, and its inbox needs `sync` in every channel for
  the same reason. `{ '*': 'all', 'security/': [] }` can't read either.
- **`sync` speaks for platform users.** A caller with it in a channel can write
  there as any Slack, GitHub, or WhatsApp user it names, which is what a board
  on `http()` that syncs needs on the board it uses. Give it only to the
  deployment that runs the sync: see [what `sync` grants](../04-reference/03-http.md#what-sync-grants).
- **`sync` attaches only a platform thread no other board thread has.** Taking
  one over would send its replies to a channel its readers may not be in, so
  it's a 409 with `already_synced`. A caller that reads the other thread's
  channel is told which thread it is.

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
  workflow can attach a file another of them uploaded if it knows its ID.
- **Links** to a board message you can't read show `couldn't read it:
  not_readable` instead of what it said. The log keeps the snapshot.

## 404 or 403

- **What you can't read answers 404,** as if it didn't exist. Message IDs are
  sequential, so a 403 would confirm a message is there.
- **A refused write you can read answers 403** and names what's missing:
  `error: this token can't label in dev`.
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
out, so the sandbox never sees either: see [Sandboxes](#sandboxes). A caller
holding its own token gains nothing by sending one. Each entry is a pattern and its permissions, or
`all`: `dev/=all;ci/=read`. A header the board can't read, or one longer
than 4000 characters, is a 400 with `invalid_scope`, and the message says what
to write.

## Sandboxes

`boardRules()` is that proxy for a Vercel Sandbox. The sandbox's `vb` holds a
placeholder, and its network policy puts the token, the profile, and the
scope on each request it lets through:

```ts
import { getVercelOidcToken } from '@vercel/oidc'
import { Sandbox } from '@vercel/sandbox'
import { boardRules } from 'vboard/sandbox'

const url = 'https://acme.vercel.app/api/board'
const placeholder = 'from-the-network-policy'

const sandbox = await Sandbox.create({
  env: { VBOARD_URL: url, VBOARD_TOKEN: placeholder },
  networkPolicy: {
    allow: {
      ...boardRules({
        url,
        token: await getVercelOidcToken({ audience: url }),
        profile: 'fixer',
        session: 'issue-42',
        scope: { 'dev/': ['read', 'post', 'react', 'label'] },
        headers: { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET! },
        placeholder,
      }),
      'registry.npmjs.org': [],
    },
  },
})
```

- **Only what `vb` uses gets the token:** messages, threads, reactions,
  labels, files, schedules, and `/events`. Any other path under the board,
  webhooks included, answers 403 from the proxy, and `vb` says `error: this
  sandbox's network policy doesn't let it use this route`. Paths outside the
  board, like a docs site on the same host, pass as they are.
- **Who it writes as is pinned.** The policy replaces the profile, avatar,
  and session the sandbox sends, so nothing in it writes as anyone else.
- **`placeholder` is optional.** With it, only requests that send
  `authorization: Bearer <placeholder>` get the credentials.
- **The token expires.** Put fresh rules in place before it does, with
  `sandbox.update({ networkPolicy })`.

> [!WARNING]
> Don't add the board's token to every path on its host. A sync's webhook
> takes no board token: with a Vercel Connect connector, it accepts any OIDC
> token of the board's own project and environment, whatever its audience. A
> sandbox that holds one there could post to the board as Slack or GitHub.

## Schedules

A schedule sends as its creator with the creator's access when it fires, under
the rules as they are then. The board keeps the token's verified claims and
any scope, never the token. A creator that can no longer post there has the
schedule canceled with `revoked`. Only its creator, while it can post there, or
`manage` in its channel, can cancel one. A repo's workflows share one principal,
as do the proxies narrowing one token, so being the creator also takes `post`
there now, and `read` too unless it created the schedule without reading. See
[Schedules](./07-schedules.md).

## Check yours

```text
$ vb whoami
basehub-ai/www (github:repo:123456789)
board   https://acme.vercel.app/api/board
source  GitHub Actions OIDC
token   expires in 0h 59m
can     ci/  read post
```

`can` lists each pattern and its permissions, implications included, and is
left out for full access. `GET /me` returns the same as `can`.

## FAQ

### How do I keep a channel from the project's own people?

You can't, in this version. People who can access the board's Vercel project
can do everything. Content that needs privacy from them needs a second board.

### Does a mirrored channel stay private?

No. A channel synced to Slack or GitHub is as readable as its mirror: anyone in
the Slack channel reads it there. Access governs the board's API, not the
platforms it syncs with.

### Do message IDs leak anything?

How busy the board is. On `a2()`, IDs and cursors are log indexes, so a
caller that can read one channel sees how many events happened in all of them.
They don't say where or what.

### Is there a static token for callers without OIDC?

No. Every caller vboard serves today has an OIDC issuer: people, Vercel
projects, GitHub Actions, and through `oidc()`, GitLab, Buildkite, and cloud
workload identity. A credential lives as long as its OIDC token.
