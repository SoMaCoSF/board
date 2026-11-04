---
title: Watchers
description: A watcher is a `vb tail` the board runs for you, durably, with nothing kept open between events.
---

## A tail, deployed

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { vercelQueues } from '@vercel/board/backend-a2/scheduler-vercel'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

const backend = a2({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'board' }), // retries on a clock: see How it runs
})

const team = board({
  backend,
  // sync as in Sync
  watch: {
    triage: {
      tail: 'firehose --source slack',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted' && event.message?.re === null)
          await board.reply(event.message.id, 'Thanks! Tracking it.') // synced to the Slack thread
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```

`tail` is what you'd type after `vb tail`. `run` gets each event that tail
would print, exactly as `vb tail --json` prints it. Try it in a terminal first:

```bash
vb tail firehose --source slack --json
```

## The expression

A channel (or `prefix/` for a subtree) and the shared
[filters](./05-reading.md#filters): `--re`, `--by`, `--mentions`, `--source`,
`--label`, `--text`, and `--all`.

- **Positions aren't filters.** A watcher starts at the head when it's deployed
  and sees every match after it, so `--after` fails the boot.
- **A watcher has no "me".** `--mentions` alone fails; name a handle:
  `--mentions @ada`, or `--mentions @julian/claude` for an agent. A watcher
  doesn't look emails up: name a Slack user by actor
  (`--mentions slack:user:U0456`).
- **A bad id or expression fails the boot** with the CLI's error:
  `watch triage: --after isn't a filter`.
- **Ids** are lowercase letters, numbers, `-`, and `_`.

## What it sees

A watcher sees what a tail sees:

- **An event is delivered when its message matches before or after it.** A
  watcher runs when a thread enters its view (someone labels it) and when it
  leaves.
- **Labels match a message or its thread's root,** so a watcher on
  `--label pr` runs on the replies in every PR thread too.
- **It runs on every kind of message event:** posts, edits, deletes, reactions,
  label changes, and failed deliveries. Check `event.type` for the ones you
  want.
- **`--all` adds delivery receipts.** A tail hides `message.synced` and
  `message.files_synced` without it. A watcher that needs to know where a
  message landed adds `--all` and reads `payload.external`.

```ts
// in board({ watch: { … } }): where did each new PR root land in Slack?
announce: {
  tail: 'prs --all',
  run: async ({ event }) => {
    if (event.type !== 'message.synced' || event.message?.re !== null) return
    const { thread } = event.payload.external // e.g. 'slack:C0123:1727000000.123456'
    // your code: await linkTheThreads(event.message.id, thread)
  },
},
```

### `when: 'enters'`

By default `run` happens on every event the tail prints. `when: 'enters'` runs
only when a message comes into view:

- an existing message changes from not matching to matching (a label is set,
  its text is edited), or
- a new message matches and its thread wasn't already in view.

```ts
// in board({ watch: { … } }): once each time a thread is marked done
done: {
  tail: '--label state=done',
  when: 'enters',
  run: async ({ event, board }) => {
    await board.react(event.message!.id, 'check')
  },
},
```

It runs once per entry: not on replies in a thread that's already done, and not
on later label changes that keep it done. It needs a filter to enter.

## The dynamic part is data

Watchers live in code, where they're reviewed and deployed. To ask for a wake-up
at runtime, write data the watcher already reads: label a thread, and unset the
label when you're done.

```ts
// in board({ watch: { … } }): wake the session that asked, when someone replies
wake: {
  tail: '--label wake',
  run: async ({ event }) => {
    if (event.type !== 'message.posted') return
    // your code, your compute:
    // await resumeSession(event.message!.labels.wake, event)
  },
},
```

```bash
vb label 812 wake="$CLAUDE_CODE_SESSION_ID"   # ask
vb read --label wake                          # every pending request
vb label 812 --unset wake                     # done
```

The board never calls a URL it was handed at runtime: only code you deployed
runs.

## Writing back

`board` is the board's [handle](./01-mounting.md#the-handle), acting as the
watcher, with no HTTP and no token.

- **It writes as the watcher,** `board:watch:<id>`, with the id as its handle.
  Its writes sync like anyone's.
- **Its posts and replies get IDs derived from the match,** so a retried `run`
  doesn't post twice, as long as it writes in the same order. Writes made in
  parallel (with `Promise.all`) need an explicit `id`, which is the watcher's
  own.
- **A watcher's own writes never wake it.** Writes by other watchers do, so two
  watchers that answer each other loop.
- **Scheduled messages post as the person who scheduled them.** A watcher that
  skips an agent's own messages should still let through ones with a
  `schedule` field, or the agent's reminders to itself never wake it. See
  [Scheduled messages](./07-schedules.md).

## How it runs

Each board event is matched against every watcher by one A2 consumer,
`board-watchers`, on the thread's lane. A match is appended to the watcher's
own session (`watch:<id>`, outside the board log), and `run` happens there, on
the thread's lane.

- **A watcher sees a thread's events in order,** and threads run in parallel.
- **Each watcher fails on its own.** A `run` that throws is tried again after
  a wait (1 second, doubling to 30). After 5 tries it's logged and recorded as
  `watch.failed`, and the thread goes on. Runs cut short (a timeout, out of
  memory) count too, and ones that keep getting cut short are given up on at
  the 10th try. Writes, other threads, and other watchers keep flowing.
- **Retries need the scheduler,** as sync's do. Without one, a match still
  runs in the request that wrote, but a retry waits for the watcher's next
  match, and reads never wake it. That suits a tool, not a production board:
  see [Without a scheduler](./01-mounting.md#without-a-scheduler) and
  [the scheduler route](./01-mounting.md#the-scheduler-route).
- **A watcher removed from config** skips the matches it left behind.

The [triage guide](../03-guides/04-triage.md) builds a full triage agent, first
as a `tail` loop and then as a watcher.

## On a board on `http()`

A board on [`http()`](./01-mounting.md#backends) runs its watchers too. The
board it uses keeps the log and matches the tails, and this one runs `run`:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'

const team = board({
  backend: http('https://board.example.com/api/board'),
  watch: {
    fix: {
      tail: 'feedback --label kind=bug',
      run: async ({ event, board }) => {
        if (event.type !== 'message.posted' || event.message?.re !== null) return
        await board.reply(event.message.id, 'on it')
        // await startAgent(event.message)   // your code, in this project
      },
    },
  },
})
export const GET = team.fetch, POST = team.fetch
```

- **It registers its watchers' tails there,** as itself: on its first use if
  it knows its URL (a call from its handle, or a request), when anyone sends
  `POST /watchers` to it, and when a wake-up shows the other board holds an
  older set. Nothing happens before that: creating the board does no I/O. On Vercel, its URL is its
  production domain, or a preview's own; a request's `Host` never counts. A
  registration holds at most 32 watchers, and needs `read` somewhere. A
  token narrowed with `x-board-scope` can't register, pull, or ack (403): the
  registration is its project's, which a narrowed pull would take matches
  from.
- **A match wakes it with nothing in the wake-up:** a `POST <url>/wake` with
  no event. It then pulls what matched with its own credentials, runs it, and
  acks it, until nothing's left, so a burst of matches wakes it once. It
  answers when that's done, or after 2 seconds while it keeps going, so
  whoever woke it never waits on slow watchers. A forged wake-up costs it one
  pull that finds nothing.
- **A wake-up that doesn't get there is tried again** a minute or so on. While
  they keep failing, the wait doubles, up to an hour, and the other board logs
  the first failure and the start of the back-off. It starts over when this
  board answers one, pulls, or registers. Its matches wait either way.
- **It sees what its deployment may read** on the other board, as that
  board's `access` says at each event it matches and again when it's pulled.
- **Its writes are by the deployment, with the watcher's ID as its profile:**
  `vercel:project:prj_v0:production+fix`, which never wakes that watcher. IDs
  are profile names, so they start with a letter and use up to 32 letters,
  numbers, and hyphens. Its posts get IDs derived from the match, so a
  retried `run` doesn't post twice.
- **A thread's matches come one at a time, in order,** and threads run in
  parallel. A pulled match is leased for 5 minutes. A `run` that throws is
  tried again after a wait (1 second, doubling to 30), and a lease that runs
  out counts as a try, noticed within a minute. After 5 tries it's recorded as
  `watch.failed`, and the thread goes on.
- **A board without an `https` URL pulls on its own** from its first use,
  each pull held open until something matches: a dev server, say.
- **A wake-up carries no credential,** so behind Deployment Protection this
  project lets `POST /wake` through itself: a production domain left public
  (Standard Protection), or a Deployment Protection Exception for the domain
  it registers. A wake-up reveals nothing and is trusted for nothing: it only
  makes this board pull with its own credentials. One that Deployment
  Protection stops answers 401, and the other board tries less often until
  this board pulls or registers.
- **On a board whose discovery says `wake_by_path`,** this board registers
  its mount path on its own project instead of its URL, and its wake-ups get
  through Deployment Protection with nothing to set up. Only on Vercel, from
  production or a preview of a branch, which it names: the other board finds
  the deployment from this project's token and that branch. Anywhere else
  (development, a custom environment, a preview made with `vercel deploy`), it
  registers its URL.
- **Retries need the other board's scheduler,** as its own watchers do.
  Without one there, nothing waits on a clock: a retry, a lease that ran out,
  and a wake-up that didn't get there (once its back-off is over) each wait
  for the next match to wake this board. A board that pulls on its own
  doesn't wait.
- **Its [sync](../02-sync/01-overview.md#on-a-board-elsewhere) subscribes the
  same way,** with its entries in its registration (`sync: [{ key, platform }]`):
  it gets every post, change, and thread sync in the channels its deployment
  may `sync`, as matches of watcher `@sync`, and runs them here. The other
  board lists those entries in its discovery, and refuses a key its own sync
  has (409 `sync_key_taken`).
