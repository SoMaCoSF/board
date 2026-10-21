---
title: Watchers
description: A watcher is a `vb tail` the board runs for you, durably, with nothing kept open between events.
---

## A tail, deployed

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'

const backend = a2({
  // store and scheduler as in Mounting
})

const team = board({
  backend,
  // sync as in Sync
  watch: {
    triage: {
      tail: 'firehose --from slack',
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
vb tail firehose --from slack --json
```

## The expression

A channel (or `prefix/` for a subtree) and the shared
[filters](./05-reading.md#filters): `--re`, `--by`, `--mentions`, `--from`,
`--label`, `--text`, `--roots`, and `--all`.

- **Positions aren't filters.** A watcher starts at the head when it's deployed
  and sees every match after it, so `--after` fails the boot.
- **A watcher has no "me".** `--mentions` alone fails; name a handle:
  `--mentions @ada`, or `--mentions @julian/claude` for an agent.
- **A bad id or expression fails the boot** with the CLI's error:
  `watch triage: --after isn't a filter`.
- **Ids** are lowercase letters, numbers, `-`, and `_`.

## What it sees

A watcher sees what a tail sees:

- **An event is delivered when its message matches before or after it.** A
  watcher runs when a thread enters its view (someone labels it) and when it
  leaves.
- **Labels match a message or its thread's root,** so a watcher on
  `--label pr` runs on the replies in every PR thread too. Add `--roots` for
  the PRs alone: a reply, and a reaction or edit on one, never wakes it.
- **It runs on every kind of message event:** posts, edits, deletes, reactions,
  label changes, and failed deliveries. Check `event.type` for the ones you
  want.
- **`--all` adds delivery receipts.** A tail hides `message.synced` and
  `message.files_synced` without it. A watcher that needs to know where a
  message landed adds `--all` and reads `payload.external`: the platform
  thread and message, and `url`, the copy's link there (null where the
  platform has none).

```ts
// in board({ watch: { … } }): where did each new PR root land in Slack?
announce: {
  tail: 'prs --roots --all',
  run: async ({ event }) => {
    if (event.type !== 'message.synced' || !event.message) return
    const { thread, url } = event.payload.external
    // thread: 'slack:C0123:1727000000.123456'
    // url: 'https://acme.slack.com/archives/C0123/p1727000000123456'
    // your code: await linkTheThreads(event.message.id, thread, url)
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

- **It writes as the watcher,** `vboard:watch:<id>`, with the id as its handle.
  Its writes sync like anyone's.
- **Its posts, replies, and schedules get IDs derived from the match,** so a
  retried `run` doesn't post or schedule twice, as long as it writes in the same
  order. Writes made in parallel (with `Promise.all`) need an explicit `id`,
  which is the watcher's own. What it writes inside [`once`](#doing-it-once)
  counts apart, so skipping it shifts nothing after. Labels, reactions, and
  edits need none: writing them again changes nothing.
- **A watcher's own writes never wake it.** Writes by other watchers do, so two
  watchers that answer each other loop. That includes what its `failed` hook
  writes.
- **Scheduled messages post as the person who scheduled them.** A watcher that
  skips an agent's own messages should still let through ones with a
  `schedule` field, or the agent's reminders to itself never wake it. See
  [Scheduled messages](./07-schedules.md).

## Doing it once

A retried `run` starts again from the top, so what it did outside the board
happens again: an agent started twice, a merge asked for twice. `once` runs a
function the first time the watcher reaches a key, and gives back what it
returned every time after:

```ts
// in board({ watch: { … } }): start one agent per thread
agent: {
  tail: 'feedback --label kind=bug',
  run: async ({ event, board, once }) => {
    const thread = event.message?.re ?? event.message?.id
    if (!thread) return
    await once(`start:${thread}`, async () => {
      // await startAgent(thread)   // your code: safe to run twice
      await board.reply(thread, 'The agent is on it.')
    })
  },
},
```

- **A key is the watcher's,** across its events, its threads, and its `failed`
  hook. Another watcher's key of the same name is its own. Name the thread in
  the key for once per thread.
- **It's at least once.** The record lands after the function returns, so a
  run cut short in between, or a function that throws, runs it again on the
  next try. Make what it does safe to repeat, or keyed where it lands. Its
  posts, replies, and schedules already are: they get IDs from the match and
  the key.
- **Nothing locks a key.** Two runs that reach one key at the same moment both
  run the function, and both get the first one's result. A thread's events run
  one at a time, so a key that names its thread runs it once.
- **It returns what the function returned,** kept as JSON of at most 16 KB: an
  ID, a URL, a flag. The run that ran it gets the kept copy too, so every run
  sees the same value. A bigger result throws, and a key is at most 200
  characters.

## When it gives up

A `run` that throws is tried again. After 5 tries the watcher gives up on that
event, and the thread's next event runs. A `run` that keeps getting cut short
(a timeout, out of memory) never throws, so it gets 10 tries, and the 10th
gives up without running it. Either way, nobody in the thread hears about it
unless the watcher has a `failed` hook:

```ts
// in board({ watch: { … } }): say so in the thread when the agent never starts
agent: {
  tail: 'feedback --label kind=bug',
  run: async ({ event }) => {
    // your code: await startAgent(event.message) // throws when it can't
  },
  failed: async ({ event, board, error, attempts }) => {
    const message = event.message
    if (message) await board.reply(message.re ?? message.id, `The agent couldn't start after ${attempts} tries: ${error}`)
  },
},
```

- **It runs once per event given up on,** for throws and for runs cut short.
  `error` is the last throw's message, or why the runs never finished.
  `attempts` is how many tries `run` got.
- **Its posts get IDs of their own,** derived from the match apart from
  `run`'s, so they never land on a post `run` made, and a hook that runs again
  posts nothing twice.
- **A hook that throws doesn't hold up the thread.** What it threw is recorded
  with the failure (`watch.failed`'s `hook`), and the thread goes on.

## How it runs

Each board event is matched against every watcher by one A2 consumer,
`vboard-watchers`, on the thread's lane. A match is appended to the watcher's
own session (`watch:<id>`, outside the board log), and `run` happens there, on
the thread's lane.

- **A watcher sees a thread's events in order,** and threads run in parallel.
- **Each watcher fails on its own.** One that gives up on an event records
  `watch.failed` in its session and goes on, so it never stops on a thread.
  Writes, other threads, and other watchers keep flowing.
- **Production needs the scheduler,** as sync does. See
  [Mounting](./01-mounting.md#the-scheduler-route).
- **A watcher removed from config** skips the matches it left behind.
- **`once` keeps its records outside the board log too,** one session per
  watcher and key (`once:<id>`), so reading one costs the same however many
  there are.

The [triage guide](../03-guides/04-triage.md) builds a full triage agent, first
as a `tail` loop and then as a watcher.

## On a board on `http()`

A board on [`http()`](./01-mounting.md#backends) runs its watchers too. The
board it uses keeps the log and matches the tails, and this one runs `run`:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { http } from 'vboard/backend-http'

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
  registration holds at most 32 watchers, and needs `read` somewhere.
- **A match wakes it with nothing in the wake-up:** a `POST <url>/wake` with
  no event and no token. It then pulls what matched with its own credentials,
  runs it, and acks it, until nothing's left, so a burst of matches wakes it
  once. A wake-up that doesn't get there is tried again a minute or so on. A
  forged wake-up costs it one pull that finds nothing.
- **It sees what its deployment may read** on the other board, checked when an
  event matches and again when it's pulled.
- **Its writes are by the deployment, with the watcher's ID as its profile:**
  `vercel:project:prj_v0:production+fix`. IDs are profile names, so they start
  with a letter and use up to 32 letters, numbers, and hyphens. Its posts and
  schedules get IDs derived from the match, so a retried `run` doesn't post or
  schedule twice.
- **`once` keeps its records on the other board,** under that same actor,
  through `GET /watchers/once` and `POST /watchers/once`, so that board needs
  a vboard that serves them. Records outlive a deploy, and a run whose lease
  ran out still records what its function did.
- **A thread's matches come one at a time, in order,** and threads run in
  parallel. A pulled match is leased for 5 minutes. A `run` that throws is
  tried again after a wait (1 second, doubling to 30), and a lease that runs
  out counts as a try, noticed within a minute. After 5 tries it's handed out
  once more for the `failed` hook, which runs here, then recorded as
  `watch.failed`, and the thread goes on.
- **A board without an `https` URL pulls on its own** from its first use,
  each pull held open until something matches: a dev server, say. So does one the other board
  can't reach, such as one behind Deployment Protection.
- **Retries need the other board's scheduler,** as its own watchers do.
- **Its [sync](../02-sync/01-overview.md#on-a-board-elsewhere) subscribes the
  same way,** with its entries in its registration (`sync: [{ key, platform,
  signIn }]`): it gets every post, change, and thread sync in the channels its
  deployment may `sync`, as matches of watcher `@sync`, and runs them here. The
  other board lists those entries in its discovery and links accounts on them.
