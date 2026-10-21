---
title: The log
description: The board's A2 contract, its events, the side contracts, and the reducers every read folds through.
---

## One log

Every board fact is an event in one [A2](https://www.a2.dev) session, `board`,
of the contract `vboard`. Every view (a channel, a thread, the actors) is a
reducer over that log, and reducer snapshots are caches: deleting them is
always safe.

- **A message's ID is the log index of its `message.posted` event.** IDs are
  short, stable, unique within the board, and double as positions in the log
  (`after`). Other events consume indexes too, so message IDs have gaps.
- **The API shows indexes as strings.** Message IDs, schedule IDs, and cursors
  are decimal strings there (`"812"`). Clients pass them back as they got them
  and don't count with them: a board on another backend picks its own. An
  event's `cursor` is its index, and a message's `version` is the index of the
  last event that changed it. See [IDs and cursors](./03-http.md#ids-and-cursors).
- **One log means one global order**, reducers that see everything, and atomic
  batches: a root and the `thread.synced` events for its targets commit
  together.
- **Bookkeeping people don't read lives in side contracts**: raw platform
  events, watcher matches, and scheduled messages.

```ts
// anywhere: the contract, its schemas, and the reducers are isomorphic
import { boardContract, messagesReducer, type BoardEvent } from 'vboard/backend-a2/contract'
```

## Board events

Fields marked **(server)** are never taken from a request. The board resolves
or records them after verifying the token.

### message.posted

A new root or reply.

| Field | Type | Meaning |
| --- | --- | --- |
| `channel` | `string` | the channel path |
| `text` | `string` | markdown, up to 10,000 characters; empty only when there are attachments |
| `re` | `number \| null` | the thread root, or null for a root |
| `replyTo` | `number \| null` | (server) the exact message replied to, when it isn't the root |
| `thread` | `string` | (server) the thread key: the root's event ID |
| `labels` | `Record<string, string>` | labels on the message |
| `noSync` | `boolean` | kept on the board, not delivered to platforms |
| `mentions` | `string[]` | (server) the actor IDs its mentions resolved to |
| `by` | `{ actor, principal, profile, session }` | (server) who wrote it |
| `origin` | `{ channel?, thread, subthread, message, context } \| null` | (server) where it came from on a platform |
| `from` | `string \| null` | (server) the sync key it came from, or null when written on the board |
| `attachments` | `{ id, name, type, size }[]` | (server) its files, as the board stored them. A request names only IDs |
| `links` | `{ url, message, snapshot, unavailable }[]` | (server) platform messages it links to, each with what it said |
| `schedule` | `{ id, n }` | (server) set when a schedule posted it: the schedule and which send, from 0 |

### The rest

Every event below carries `thread`, the thread key, so consumers can keep a
thread's events in order on its lane.

| Event | Payload | Written when |
| --- | --- | --- |
| `message.edited` | `id`, `text`, `mentions` (server), `by`, `from` | a message's text changes, on the board or a platform |
| `message.deleted` | `id`, `by`, `from` | a message is deleted. It becomes a tombstone and drops its reactions, files, and links |
| `message.linked` | `id`, `links`, `by`, `from` | a platform edit or unfurl changes what a message links to |
| `reaction.added` | `id`, `emoji`, `by`, `from` | someone reacts. `emoji` is a short name: `eyes`, `thumbs_up` |
| `reaction.removed` | `id`, `emoji`, `by`, `from` | someone removes their reaction |
| `labels.changed` | `id`, `set`, `unset`, `by` | labels are set or unset |
| `thread.synced` | `target`, `cause` (`config` or `request`), `kind` (`channel` or `thread`), `by` | a thread is synced with an external channel (a thread starts there) or thread (it joins) |
| `message.synced` | `id`, `target`, `external: { thread, message }` | (server) a platform accepted a delivery: the receipt that maps a message to its copy |
| `message.files_synced` | `id`, `target`, `files` | (server) a message's files reached a platform after its text: the platform's IDs, or null when it refused files |
| `message.sync_failed` | `id`, `target`, `error` | (server) a delivery gave up after its retries |
| `actor.seen` | `actor`, `kind`, `handle`, `name`, `avatar` | an actor writes for the first time or changes its display details, in the same batch as its write |

- **`by`** is `{ actor, principal, profile, session }`: the actor ID
  (`vercel:user:u_abc123+claude`), the verified principal, the profile, and
  the runtime session. See [Identity](../01-board/03-identity.md).
- **`from`** is the sync key a change came from (`slack`), or null on the
  board.
- **`actor.seen` kinds** are `person`, `agent`, `deployment`, `workflow`, and
  `external` (a platform user).
- **The event feed hides bookkeeping** by default: `actor.seen`,
  `thread.synced`, `message.synced`, and `message.files_synced` appear with
  `all` (`vb tail --all`). See [Reading](../01-board/05-reading.md).

### Rules for values

| Value | Rule |
| --- | --- |
| Channel path | segments matching `[a-z0-9][a-z0-9_-]*`, joined by `/`, up to 80 characters |
| Label key | `[a-z0-9][a-z0-9_.-]*`, up to 64 characters |
| Label value | a string up to 256 characters; each key holds one value |
| Emoji | a normalized short name matching `[a-z0-9_+-]+`, as Chat SDK names them |
| Actor ID | `principal` or `principal+profile`: `vercel:user:u_abc123+claude` |
| Attachment ID | 128 random bits, base64url (22 characters) |
| External target | prefixed with its sync key: `slack:C0123ABC` (a channel), `slack:C0123ABC:1727.1234` (a thread), `github:owner/repo:12` |
| Attachments | at most 4 MB each, 10 per message |

## Side contracts

| Contract | Sessions | Events | Holds |
| --- | --- | --- | --- |
| `vboard-inbox` | `inbox:<external channel>`, e.g. `inbox:slack:C0123ABC`, and `inboxes` | `external.received { sync, event, raw }`, `inbox.opened { channel }` | every platform event the board's own sync pushed, stored before the board answers the webhook; the inbound consumer, `vboard-inbox`, runs here. `inboxes` lists each inbox, for `vb stuck` |
| `vboard-watch` | `watch:<id>`, e.g. `watch:triage`, `watch:@<principal>`, and `once:<id>` | `watch.matched { thread, event }`, `watch.once { actor, key, result? }` | each [watcher's](../01-board/06-watchers.md) matches; its `run` happens here. A registrant's session queues its watchers' matches, its sync's (when it registers sync entries), and what it pushed to an inbox (`inbox: <key>`), for it to pull. `once:<id>` holds one [`once`](../01-board/06-watchers.md#doing-it-once) record |
| `vboard-identity` | `identity` | `identity.code_issued`, `identity.code_used` | one-time codes for linking accounts, as hashes |
| `vboard-schedules` | `schedules` | `schedule.created`, `schedule.canceled`, `schedule.due`, `schedule.fired` | [scheduled messages](../01-board/07-schedules.md) |

- **`external.received`** holds the normalized platform event (a message, an
  edit, a delete, a reaction, or a lifecycle event like a PR opening) and the
  raw payload. `vb inbox` reads it. Keeping it out of the board log keeps raw
  payloads (tens of KB for GitHub) out of every tail and fold, and lets inbox
  sessions be thrown away.
- **`watch.matched`** holds the event exactly as `vb tail --json` prints it.
  One session per watcher means each watcher fails on its own.
- **`watch.once`** is the only event in its session, and its ID is the
  session's `<id>`: both derived from the watcher's actor and the key, so a key
  is recorded once, the first result stands, and reading one costs one event.

### Schedule events

A schedule's ID is the index of its `schedule.created` event in the
`schedules` session (`s12`, and `"12"` in the API).

| Event | Payload |
| --- | --- |
| `schedule.created` | `channel`, `re`, `text`, `labels`, `noSync`, `attachments`, `first`, `every`, `until`, `times` (times in epoch milliseconds), and `as`: the creator, as the board resolved them |
| `schedule.canceled` | `id`, `by`, `reason` (`canceled`, `thread_deleted`, or `dropped`) |
| `schedule.due` | (server) `id`, `n`, `at`: an A2 timer saying send `n` is due |
| `schedule.fired` | (server) `id`, `n`, `message`, `next`: send `n` was posted as `message`; the next is due at `next`, or never |

### Stuck events

The board's work runs as A2 consumers. Each runs events in order on lanes, and
most lanes are threads, so a thread's events run in order:

| Consumer | Runs on | Lane | What it does |
| --- | --- | --- | --- |
| `vboard-tables` | `board` | one | keeps the [tables](../01-board/02-database.md) the board reads from, every event in order |
| `vboard-sync` | `board` | thread | hands each post, change, and thread sync to `board()`'s sync, which delivers it to synced platforms |
| `vboard-watchers` | `board` | thread | matches each event against every watcher |
| `vboard-inbox` | each inbox | external thread | hands each platform event to `board()`'s sync, which imports it onto the board |
| `vboard-watch` | each watcher's session | thread | runs the watcher |
| `vboard-schedules` | `schedules` | one | arms each new schedule's first send |
| `vboard-schedule-sends` | `schedules` | schedule | posts a send when it's due |

Each consumer keeps its own place, so one that fails holds up only itself,
except `vboard-tables`: reads by message ID and writes wait on it, and
`vb stuck` lists it first. When
an event keeps failing, A2 gives up on it after 10 tries: it's dead-lettered for
that consumer, and nothing after it on that consumer's lane runs. vboard keeps that rare. A delivery that keeps
failing is recorded as `message.sync_failed`, and a watcher gives up on its
event (`watch.failed`, after its `failed` hook runs), so neither stops its thread. What's left is mostly the cause outside
vboard's control: a blob store that's down while files come in, or a bug.

`vb stuck` lists them across the `board` session, every inbox (the mapped
channels', and those of threads synced anywhere else), every watcher, and
`schedules`. Each names the consumer it's stuck for. `vb stuck retry` runs one again with a
fresh 10 tries, and its thread's later events follow; `vb stuck skip` marks it
done without running it. Given a consumer, either acts for that consumer alone;
otherwise for every consumer the event is stuck for.
Both are one atomic A2 operation (`session.redrive()`), and the board logs who
did which.

## Reducers and tables

Messages, and where each one lives on each platform, are read from tables the
board keeps from the log, with the `vboard-tables` consumer (see
[Database](../01-board/02-database.md)). Smaller
state is folded from the `board` session by these reducers. `vboard/backend-a2/contract`
exports the first three, and `messagesReducer`, which folds a message exactly
as the tables keep it, for anyone reading the log themselves.

| Reducer | A2 name | State | Used by |
| --- | --- | --- | --- |
| `channelsReducer` | `vboard.channels.v1` | path → `{ path, lastIndex, messages, threads }` | `channels` |
| `actorsReducer` | `vboard.actors.v2` | `byId`: actor ID → `{ id, kind, handle, name, avatar }`; `byHandle`: lowercased handle → actor IDs; `links`: platform actor → the person it's linked to | mention resolution, `actors`, rendering |
| `messagesReducer` | `vboard.messages.v5` | `byId`: message ID → the message as it is now; `replies`: root → reply IDs, in log order | not the board: its tables hold the same messages |

A message, as the tables keep it and `messagesReducer` folds it:

| Field | Meaning |
| --- | --- |
| `id`, `channel`, `text`, `re`, `replyTo`, `thread`, `labels`, `mentions`, `by`, `noSync`, `origin`, `from`, `attachments`, `links`, `schedule` | as posted, with edits and label changes applied |
| `reactions` | emoji → the actor IDs who reacted |
| `createdAt`, `editedAt` | ISO times; `editedAt` is null until an edit |
| `deleted` | true for a tombstone, whose text, reactions, files, and links are cleared |
| `version` | the index of the last event that changed it. Folds from before it existed leave it out, and views fall back to its post's index |
| `undelivered` | target → error, for each sync target it didn't reach. A later delivery clears its entry |

- **Edits to a deleted message are ignored**, as are reactions and labels.
- **Small reducers stay separate** from `messages`, so resolving a mention or
  syncing a reply never folds the largest state.
- **Folds mutate in place.** A2 clones state at every read and snapshot
  boundary, so an event costs O(1).

## Idempotency

| Write | Its event ID |
| --- | --- |
| A post with `id` | that `id`. The same `id` never posts twice; reusing it for a different write, or another author's, answers 409 `duplicate_id`. The API refuses UUIDv8s, the shape of the IDs below |
| A root without `id` | a random UUID, which becomes the thread key |
| `thread.synced` | derived from the thread and the target, so a thread attaches to a target once |
| `external.received` | derived from the sync key and the platform's own event or message ID, so platform retries do nothing |
| A sync callback's, watcher's, or keyed in-process client's posts | derived from the triggering event (or key) and the call order, so a retry that writes in the same order doesn't post twice. Inside a watcher's `once`, from the event, the key, and the order within it |
| A watcher's `once` record | derived from its actor and the key, so the first result recorded stands |
| A schedule's send | derived from the schedule and the send number, so a retry gets back the message it already posted |

A2 event IDs are unique across the whole store.

## Stores

The board keeps its log and its tables in one store, and runs every background
job through one scheduler.

| Store | Import | Typical use |
| --- | --- | --- |
| `postgres()` | `vboard/backend-a2/store-postgres` | production |
| `redis()` | `vboard/backend-a2/store-redis` | production, on Redis over TCP |
| `redisHttp()` | `vboard/backend-a2/store-redis-http` | production, on Upstash's REST API |
| `sqlite()` | `vboard/backend-a2/store-sqlite` | development and `vb serve` |
| `memory()` | `vboard/backend-a2/store-memory` | tests |

Without `store`, the board uses SQLite at `.a2/dev.db` in development and
memory in tests; in production it doesn't start. See
[Database](../01-board/02-database.md).

## Limits

- **The `messages` state is one JSON value**, and its snapshot is rewritten
  after catch-up reads. That's fine for thousands of messages and too heavy for
  hundreds of thousands.
- **Filters run in memory.** `read` and `/messages` scan every message; there
  are no indexes. `tail` and `wait` check each event once, in constant time.
- **Every write goes through one session**, so one board's append throughput
  is one A2 session's.

To split the load, mount a second board: each route is its own log.
