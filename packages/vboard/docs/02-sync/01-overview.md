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

Sync is configured per platform, keyed by the platform's own things: Slack
channels, GitHub repos, WhatsApp numbers. Each key maps to a board channel (a
two-way mirror) or to a function that handles inbound events however you like.

Sync runs in `board()`, wherever the board lives. It keeps its records on the
backend through routes every backend answers: imports as platform authors,
delivery receipts, lookups by platform ID, and an inbox of platform events. So
it works the same on `a2()` and on a board on `http()`: see
[On a board elsewhere](#on-a-board-elsewhere).

## Configure it

Each entry under `sync` is one platform account, keyed by a name you choose:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { slack } from 'vboard/sync-slack'
import { github } from 'vboard/sync-github'
import { vercelQueues } from 'vboard/backend-a2/scheduler-vercel'
import { postgres } from 'vboard/backend-a2/store-postgres'

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'vboard' }),
})

const team = board({
  backend,
  sync: {
    slack: slack({
      adapter: 'slack/acme', // a Vercel Connect connector
      channels: {
        '#errors-www': 'errors-www',
        '#prs': 'prs',
      },
    }),
    github: github({
      adapter: 'github/acme',
      repos: {
        'acme/www': { pulls: 'prs', issues: 'issues' },
      },
    }),
  },
})
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

On `a2()`, sync runs on two A2 consumers, `vboard-inbox` in and `vboard-sync`
out, so production needs the scheduler for their retries. Mount the
backend's `scheduler` in a route of its own, outside the board's catch-all:

```ts app/api/a2/scheduler/route.ts
export { scheduler as POST } from '@/app/api/board/[[...path]]/route'
```

A Vercel Queues trigger makes that function private, which is why it can't share
the board's public route. [Mounting](../01-board/01-mounting.md) covers the store,
the scheduler, and their routes. To pass your own Chat SDK adapter instead of a
connector, see [Slack](./03-slack.md#your-own-adapter) and [GitHub](./04-github.md#setup).

## Mappings

Each mapping picks one of three behaviors:

| Value | What it does |
| --- | --- |
| `'errors-www'` | A two-way mirror. Inbound events import into that board channel; board roots there start external threads where the platform can. |
| `async ({ event, board }) => {}` | A callback for every inbound event, connected threads included. It decides what to import. |
| `{ channel, run }` | A callback, plus a static channel so board roots still start external threads. |

The function forms are covered in [Callbacks](./02-callbacks.md).

**Entry keys** (`slack`, `github`, or `acme` for a second Slack workspace) are
names you choose; the adapter decides the platform. The key appears in external
IDs (`acme:C0999XYZ:1727.9`), in sync targets, in `--from` filters, and in the
webhook path (`/webhooks/acme`).

**Mapping keys** are the platform's names or IDs: `'#prs'` or `'C0123ABC'` for
Slack, `'owner/repo'` for GitHub, a phone number ID for WhatsApp.

- Slack names resolve through one cached channel listing. IDs survive renames;
  a renamed channel stops matching by name on the next cold start.
- Each key resolves on its own. One that can't (a channel that doesn't exist
  yet, a missing scope) is logged and skipped, retried at most once a minute,
  and the rest sync.

## The rules

1. **Delivery.** Every message, edit, delete, and reaction in a thread goes to
   every external thread it's synced with, except the one it came from. Where a
   platform can't do something (WhatsApp edits, GitHub typing), that delivery is
   skipped.
2. **Starting threads.** A root posted on the board, by anyone or any watcher,
   starts a thread in each mirrored channel on platforms that can start threads in
   a channel. Slack can. GitHub and WhatsApp can't, so roots never open an issue
   or a conversation.
3. **Inbound.** A platform event is handled when its thread is already synced
   (it becomes a reply, reaction, edit, or delete) or when its channel is in
   config (it goes to the mirror or your function). Everything else is ignored,
   even in channels the bot belongs to.
4. **Targets are resolved once,** when a root is posted. A root posted through
   this board lands with them, as `thread.synced` events in the same batch; one
   written straight on the board it uses gets them when sync sees it. Either
   way, a deploy that changes mappings affects new threads only.
5. **Attaching.** `vb sync <id> <target>` attaches an existing thread. A channel
   target gets the root and a backfill of every reply, in order. A thread target
   joins an existing external thread and receives only what's written after.
6. **Grouping.** Each adapter decides which board thread an external thread
   belongs to. GitHub's inline review threads land in their PR's thread.
7. **Reply targets.** A reply to a message that came from a platform sub-thread
   (a GitHub review thread) goes into that sub-thread there. Everywhere else it
   goes into the main thread as written. vboard adds no quote of the message it
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

`--no-sync` keeps a message on the board: a root with it starts no threads in
mirrored channels, and a reply with it isn't delivered. `--sync` and `--no-sync`
together are a usage error. A handle's `post` takes `sync: [...]` and
`noSync: true`; see the [handle reference](../04-reference/02-board.md).

## On a board elsewhere

A board on [`http()`](../01-board/01-mounting.md#backends) keeps nothing, and
its sync still runs here:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { http } from 'vboard/backend-http'
import { slack } from 'vboard/sync-slack'

const team = board({
  backend: http('https://board.example.com/api/board'),
  sync: {
    slack: slack({ adapter: 'slack/acme', channels: { '#support': 'support' } }),
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
  in its `a2({ access })`. See [what `sync` grants](../04-reference/03-http.md#what-sync-grants).

A [callback](./02-callbacks.md)'s writes land on the other board as the
platform user, and its reads are this deployment's. This board registers its
entries there, so the other board lists them and links accounts on them. People
link the other board, so `vb identity link slack` gets its code there; this
board's sync redeems it when it comes in from Slack, and an entry that signs
people in does it here, at the sign-in the code's `signIn` names. Two
boards that sync the same platform channel into one board each import its
events and each deliver to it, so give each channel one syncer.

## Set up webhooks

Every entry gets its webhook route automatically: `/webhooks/<key>` under the
board's mount, e.g. `https://example.com/api/board/webhooks/slack`. It's the only
route that takes no board token; the adapter verifies the request instead. The
setup happens on the platform, once per entry and deployment.

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

On the way in, the webhook stores each event before it answers, then `vboard-inbox`
imports it on the external thread's lane. A failure there answers the platform
with a 500 so it retries. A [callback](./02-callbacks.md) that keeps throwing
dead-letters after 10 tries, which holds up only that thread's lane in that
channel's inbox.

## Typing

```ts
// in the route that mounts the board with its `sync`:
await team.typing('812', 'running tests…')
```

Shows typing in every platform thread the board thread is synced to, through
the sync this board runs: only a board that runs it shows any, so `vb typing`,
whose own board runs none, shows nowhere. Slack shows
the status under the thread, WhatsApp shows "typing…" and marks the latest inbound
message read, and GitHub has no typing. Nothing is written to the log. It needs
`post` and `read` in the thread's channel.

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
Each raw event lives in an inbox session per external channel, outside the board
log; see [the log](../04-reference/04-log.md).
