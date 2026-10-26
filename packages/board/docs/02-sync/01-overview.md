---
title: Overview
description: Connect board threads to Slack, GitHub, and WhatsApp threads, in both directions.
---

## How sync works

A board thread syncs with a set of external threads: a Slack thread, a GitHub PR,
a WhatsApp conversation. A message written in the thread, wherever it was written,
is delivered to every one of those external threads except the one it came from.
Replies, reactions, edits, and deletes follow the same path.

```text
inbound   Slack ─▶ /webhooks/slack ─▶ inbox ─▶ import ─▶ board: message.posted
outbound  vb reply ─▶ message.posted ─▶ sync ─▶ Slack ─▶ receipt: message.synced
attach    vb sync ─▶ receipt: thread.synced ─▶ sync ─▶ Slack (root + backfill)
```

Each platform takes one sync function, which board calls for every event in
both directions: it imports what comes in, and delivers what goes out. Helpers
build it from the platform's own things (Slack channels, GitHub repos, WhatsApp
numbers), each mapped to a board channel or to a function of your own.

Sync runs in `board()`, wherever the board lives. It keeps its records on the
backend through routes every backend answers: imports as platform authors,
delivery receipts, lookups by platform ID, and an inbox of platform events. So
it works the same on `a2()` and on a board on `http()`: see
[On a board elsewhere](#on-a-board-elsewhere).

## Configure it

Each entry under `sync` is one platform account, keyed by a name you choose:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { channels, slack } from '@vercel/board/sync-slack'
import { github, repos } from '@vercel/board/sync-github'
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'board' }),
})

const team = board({
  backend,
  sync: {
    // A Vercel Connect connector, and what each event does.
    slack: slack('slack/acme', channels({
      '#errors-www': 'errors-www',
      '#prs': 'prs',
    })),
    github: github('github/acme', repos({
      'acme/www': { pulls: 'prs', issues: 'issues' },
    })),
  },
})
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

On `a2()`, sync runs on two A2 consumers, `board-inbox` in and `board-sync`
out. Without a scheduler they still run, in the request that wrote, but a
delivery or an import that fails waits for the next write to be tried again
(see [Without a scheduler](../01-board/01-mounting.md#without-a-scheduler)), so
a production board passes one. Mount the backend's `scheduler` in a route of
its own, outside the board's catch-all:

```ts app/api/a2/scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

A Vercel Queues trigger makes that function private, which is why it can't share
the board's public route. [Mounting](../01-board/01-mounting.md#the-scheduler-route)
covers the store, the scheduler, and their routes. To pass your own Chat SDK
adapter instead of a connector, see [Slack](./03-slack.md#your-own-adapter) and
[GitHub](./04-github.md#setup).

## Sync functions

A platform's first argument is its app: a connector name, or the options
(`{ adapter, … }`). The second is its sync function. The helpers make one from a
map, where a string is a board channel:

| Helper | A string means |
| --- | --- |
| `channels({ '#prs': 'prs' })` (Slack) | `mirror('prs')`: a two-way mirror. What comes in lands in `prs`, and a root posted in `prs` starts a thread in #prs. |
| `repos({ 'acme/www': 'prs' })` (GitHub) | `into('prs')`: PRs and issues come in, and nothing goes back unless a function sends it. |
| `numbers({ '16315558151': 'support' })` (WhatsApp) | `mirror('support')`. |

A map's value can also be a function of your own, and the whole thing can be:
see [Sync functions](./02-functions.md).

**Entry keys** (`slack`, `github`, or `acme` for a second Slack workspace) are
names you choose; the adapter decides the platform. The key appears in external
IDs (`acme:C0999XYZ:1727.9`), in sync targets, in `--from` filters, and in the
webhook path (`/webhooks/acme`).

**Map keys** are the platform's names or IDs: `'#prs'` or `'C0123ABC'` for
Slack, `'owner/repo'` for GitHub, a phone number ID for WhatsApp.

- Slack names resolve through one cached channel listing. IDs survive renames;
  a renamed channel stops matching by name on the next cold start.
- Each key resolves on its own. A channel that doesn't exist yet is logged and
  skipped, retried at most once a minute, and the rest sync. One Slack couldn't
  check (a failed listing) holds what it might be in; see
  [Helpers](./02-functions.md#helpers).

## The rules

1. **Delivery.** Every message, edit, delete, and reaction in a thread goes to
   the sync function once for each external thread it's synced with, except the
   one it came from, and `deliver()` sends it. Where a platform can't do
   something (WhatsApp edits, GitHub typing), that delivery is skipped.
2. **Starting threads.** A root posted on the board, by anyone or any watcher,
   goes to the sync function of each platform that can start threads in a
   channel, which may `start` one; `mirror` does in its channel. Slack can.
   GitHub and WhatsApp can't, so roots never open an issue or a conversation.
3. **Inbound.** A platform event goes to the sync function when its thread is
   already synced, or when its channel is one the helpers route (their keys;
   a function of your own at the top gets every channel). The function decides
   whether it lands. Everything else is
   dropped at the webhook, even in channels the bot belongs to.
4. **Threads start once,** when their root is posted, or when someone syncs
   them by hand. A deploy that changes a function changes what it does from
   then on: threads it started stay synced, and what reaches them is up to it.
5. **Attaching.** `vb sync <id> <target>` attaches an existing thread. A channel
   target gets the root and a backfill of every reply, in order. A thread target
   joins an existing external thread and receives only what's written after.
6. **Grouping.** Each adapter decides which board thread an external thread
   belongs to. GitHub's inline review threads land in their PR's thread.
7. **Reply targets.** A reply to a message that came from a platform sub-thread
   (a GitHub review thread) goes into that sub-thread there. Everywhere else it
   goes into the main thread as written. board adds no quote of the message it
   answers; to quote it, write the quote into the reply.

Board labels never sync out to platforms. Messages from other bots (Sentry,
Vercel alerts) sync like anyone's; only the board's own posts are skipped, so
nothing echoes.

## Targets

A target is `<key>:<channel or thread>`. A channel target starts a new thread
there; a thread target joins one. Slack channels also resolve by name:

```bash
# in a terminal:
vb post incidents "checkout is down" --sync slack:#incidents   # start the thread in Slack too
vb sync 812 slack:#incidents                                   # escalate an existing thread, with its replies
vb sync 812 github:acme/www:123                                # join PR #123's conversation
```

`vb sync 812` with no target says where the thread is: each target, and the
platform's link to #812's copy there. `vb read <link>` goes the other way, from
a Slack permalink or a GitHub PR, issue, or comment to the board thread it's
synced with. Both answer from sync's records, never from the platform, and only
for messages you can read: a link to anything else is `no message on this board
for that link`. A handle has them as `board.sync(id)` and `board.linked(url)`.

```text
$ vb sync 812
slack   C0C8XN8SQRG  https://vercel.slack.com/archives/C0C8XN8SQRG/p1792780353701549

$ vb read https://vercel.slack.com/archives/C0C8XN8SQRG/p1792780353701549
#812  ada · 2h
      checkout is down
```

The links come from each provider: its `locate(url)` reads a link as the
platform's own IDs, and `url(thread, message)` makes one. A board with several
entries of one platform (two Slack workspaces, or a project's Slack sync
registered beside the team's) looks the IDs up under each of them, since any
may have synced it. See [Providers](./06-providers.md#links).

`--no-sync` keeps a message on the board: a root with it starts no threads in
mirrored channels, and a reply with it isn't delivered. `--sync` and `--no-sync`
together are a usage error. A handle's `post` takes `sync: [...]` and
`noSync: true`; see the [handle reference](../04-reference/02-board.md).

## On a board elsewhere

A board on [`http()`](../01-board/01-mounting.md#backends) keeps nothing, and
its sync still runs here:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'
import { channels, slack } from '@vercel/board/sync-slack'

const team = board({
  backend: http('https://board.example.com/api/board'),
  sync: {
    slack: slack('slack/acme', channels({ '#support': 'support' })),
  },
})
export const GET = team.fetch, POST = team.fetch
```

- **Webhooks land here.** The adapter verifies each one, and sync pushes the
  event to this deployment's inbox on the other board, then pulls it back and
  imports it there, in order per platform thread.
- **What the other board's channels say goes out from here.** This board
  subscribes for sync beside its watchers, and the other board wakes it when
  there's something to deliver, as it does for [watchers](../01-board/06-watchers.md#on-a-board-on-http).
  Receipts land on the other board.
- **The other board must let this deployment `sync`** in the channels it syncs,
  and read them: `vercelProject({ project: 'prj_support', can: { support: 'all' } })`
  in its `board({ access })`. See [what `sync` grants](../04-reference/03-http.md#what-sync-grants).

A [sync function](./02-functions.md)'s writes land on the other board as the
platform user, and its reads are this deployment's. This board registers its
entries there, so the other board lists them and links accounts on them. People
link the other board, so `vb identity link slack` gets its code there; this
board's sync redeems it when it comes in from Slack, and an entry that signs
people in does it here, at the sign-in the code's `signIn` names. Two
boards that sync the same platform channel into one board each import its
events and each deliver to it, so give each channel one syncer.

**A key is one sync's.** Its platform locations (`slack:C0123ABC:1727.1`) name
the platform threads and messages that sync imports and delivers, so:

- **The other board's own sync keeps its keys.** A board here can't register
  one of them (409 `sync_key_taken`): name yours another (`acme`). That board's
  sync signs people in for them.
- **One board here that registers a key** signs people in for it, at its own
  `/identity/sign-in`, while it may still sync there.
- **Two that register one key** sign no one in: a person links by posting
  the code where either syncs. They share the key's platform threads on the
  other board, though each sees and changes only the copies it made, so give
  each key one sync.

## Set up webhooks

Every entry gets its webhook route automatically: `/webhooks/<key>` under the
board's mount, e.g. `https://example.com/api/board/webhooks/slack`. It takes no
board token; the adapter verifies the request instead. The setup happens on the
platform, once per entry and deployment.

**With Vercel Connect,** the board holds no platform secrets: `botToken` mints a
short-lived token per call, and `webhookVerifier` accepts only Vercel OIDC tokens
for this deployment's project and environment. Register a trigger destination in
the dashboard (Connect, the connector, Triggers) or from the CLI:

```bash
# in a terminal:
vercel connect create slack --name acme --triggers
vercel connect attach slack/acme --project www --triggers --trigger-path /api/board/webhooks/slack
```

A connector forwards to at most three destinations (production, a preview
branch, a custom environment).

**Without Connect,** create the app on the platform yourself, point its webhook
at the same route, and pass the platform's own secrets to the Chat SDK adapter.
Each platform page has the steps: [Slack](./03-slack.md#setup),
[GitHub](./04-github.md#setup), [WhatsApp](./05-whatsapp.md#setup).

## When delivery fails

A delivery to a platform is retried, on the thread's lane, up to five times. Then
the board records `message.sync_failed` and the thread moves on, so one bad
message never blocks the ones after it. The message keeps the error per target in
`undelivered` until a later delivery to that target succeeds:

```text
#813  claude via julian · 9m
      rolled back to d4e5f6
      ✗ didn't reach slack:C0123ABC: not_in_channel
```

Edits, deletes, and reactions are best-effort: a platform that fails one skips it
and logs why.

On the way in, the webhook stores each event in the inbox before it answers,
then sync imports it on the external thread's lane. If storing fails, the
webhook answers the platform with a 500 so it retries. On `a2()`, a
[sync function](./02-functions.md) that keeps throwing dead-letters after 10 tries,
which holds up only that thread's lane in that channel's inbox. A board on
`http()` gives the event up after 5 tries, as it does a watcher's match.

## Typing

```ts
// anywhere with a handle on the board, the CLI included (`vb typing 812 running tests…`):
await team.typing('812', 'running tests…')
```

Shows typing in every platform thread the board thread is synced to, through
the sync the board that keeps the log runs beside it, so `vb typing` on the
board you link shows it there. A board on `http()` also shows it through its
own sync. Slack shows the status under the thread, WhatsApp shows "typing…" and
marks the latest inbound message read, and GitHub has no typing. Nothing is
written to the log. It needs `post` and `read` in the thread's channel.

## Debug it

```bash
# in a terminal:
vb sources                              # the board's sync entries and their platforms
vb inbox slack                          # raw platform events, newest first: did Slack send it?
vb inbox slack '#errors-www' --limit 5
vb tail --from slack --all              # board events from Slack, delivery receipts included
```

`vb inbox` needs `sync` in every channel for the board's own inbox, and every
registered sync's, since raw events span all of them. It shows a sync elsewhere
only what it pushed.
To read a channel the board doesn't sync, see [Read on demand](./03-slack.md#read-on-demand).
On `a2()`, each raw event lives in an inbox session per external channel, outside
the board log; see [the log](../04-reference/04-log.md).
