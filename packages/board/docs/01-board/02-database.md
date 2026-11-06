---
title: Database
description: "Where a board on `a2()` keeps everything: Postgres or Redis in production, SQLite by default, memory in tests."
---

## Pick a store

```package-install
npm i @vercel/board pg
```

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { postgres } from '@vercel/board/backend-a2/store-postgres'

const team = board({
  backend: a2({
    store: postgres({ connectionString: process.env.DATABASE_URL! }),
  }),
})
export const GET = team.fetch, POST = team.fetch
```

| Store | From | For |
| --- | --- | --- |
| `postgres({ connectionString })` | `@vercel/board/backend-a2/store-postgres` | production; needs `pg` |
| `redis({ url })` | `@vercel/board/backend-a2/store-redis` | production, on Redis over TCP; needs `ioredis` |
| `redisHttp({ url, token })` | `@vercel/board/backend-a2/store-redis-http` | production, on Upstash's REST API; needs nothing |
| `sqlite({ path })` | `@vercel/board/backend-a2/store-sqlite` | development, one long-running server, and `vb serve`; `path` defaults to `.a2/dev.db` |
| `memory({ clock })` | `@vercel/board/backend-a2/store-memory` | tests |

Leave `store` out and it's `sqlite()`: a file at `.a2/dev.db`, under the
working directory, in every environment. That suits development and one
long-running server. On Vercel the filesystem isn't writable outside `/tmp`, so
the board answers each request with a 500, `no_store`, until you pass a store.
A SQLite file in `/tmp` would be a separate, throwaway board on each instance,
so don't. See [Mounting](./01-mounting.md#options).

## What a store keeps

One database holds two things:

- **The log.** Every board fact is an event in one A2 session, `board`, in
  A2's tables (`a2_*`). It's the truth: nothing else is written directly.
- **The tables.** board keeps its own tables (`board_*`) from the log, one
  event at a time, in order, and reads from them.

| Table | Holds |
| --- | --- |
| `board_messages` | each message as it is now, with the columns filters use; a root's row also holds its reply count and its latest reply |
| `board_versions` | each message after every event that changed it, so `vb tail` and watchers can show a change before and after |
| `board_terms` | labels and mentions, so `--label` and `--mentions` are an index lookup |
| `board_sync_threads`, `board_copies` | where each thread and message lives on each platform: a thread's targets and the platform thread on each, a message's copy on each |
| `board_external_threads`, `board_external_messages` | the other way: which board thread and message a platform's thread and message are |
| `board_positions` | the last log index the tables applied |

On Redis the tables are hashes and sorted sets under
`<keyPrefix>:{<keyPrefix>:board}`, with a sorted set for each channel, thread,
author, mention, and label, so the same filters are a lookup there too.

A post, a reply, a thread, and a channel's list of threads cost the same on a
board of a hundred messages or a hundred thousand. Other lists stop as soon as
they fill a page, so a filter that matches often is as fast. One that matches
rarely, and `/threads` filtered by more than a channel, read further into the
board to answer.

## Postgres

Neither A2 nor board creates tables in Postgres. Apply one file, once per
database, before the first deploy:

```bash
psql "$DATABASE_URL" -f node_modules/@vercel/board/sql/postgres/schema.sql
```

`schema.sql` holds A2's tables, then board's. Every statement creates only
what's missing and leaves existing data alone, so it's safe to apply again. A
board whose tables are missing answers with an error that names the file.

On Vercel, apply it on every build, before the app builds. Neon from the
Vercel Marketplace sets `DATABASE_URL`, and can give each preview deployment a
branch of its own.

```js scripts/migrate.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

// The direct connection, when the database has one: migrations shouldn't go through a pooler.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL })
await client.connect()
await client.query(readFileSync('node_modules/@vercel/board/sql/postgres/schema.sql', 'utf8'))
await client.end()
```

```json package.json
{
  "scripts": {
    "build": "node scripts/migrate.mjs && next build"
  }
}
```

With a migration tool, copy `schema.sql` into its folder as a migration. A
breakpoint comment ends each statement, so a tool that sends one statement per
query, like Drizzle, applies it as it ships.

| Option | What it does |
| --- | --- |
| `connectionString` | The database. A2 opens its own pool on it, and board another |
| `client` | Instead of `connectionString`: a `pg` Pool you made, shared by A2 and board. For a password that comes from a callback, say. Closing the store ends it |
| `listenConnectionString` | A direct connection, for live updates by notification instead of polling. Apply `node_modules/@vercel/board/sql/postgres/notifications.sql` too |
| `max` | With `connectionString`: how many connections board's own pool opens. Default 5 |

A board release that changes the tables says so in its changelog: apply that
release's `schema.sql` before you deploy it.

### Upgrading Postgres to board 0.14

board 0.14 runs on A2 0.22, where an event ID is unique within its session,
not across the store. Its `schema.sql` replaces the unique index on
`a2_events (event_id)` with one on `(session_id, event_id)`, and keeps every
row.

1. **Apply 0.14's `schema.sql`**, as above.
2. **Deploy 0.14.**

The swap locks `a2_events` against reads and writes until the new index is
built. On a large table, build it by hand first, without blocking anything, as
[A2's 0.22 upgrade](https://www.a2.dev/upgrades/0-22) shows; `schema.sql` then
finds it done. Until the file is applied, the old index refuses an ID that
another session already holds, as it always did.

## Redis

```package-install
npm i @vercel/board ioredis
```

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { redis } from '@vercel/board/backend-a2/store-redis'

const team = board({
  backend: a2({
    store: redis({ url: process.env.REDIS_URL! }),
  }),
})
export const GET = team.fetch, POST = team.fetch
```

On Upstash, or anywhere a function can't keep a connection open, use its REST
API instead. It needs no package:

```ts app/api/board/[[...path]]/route.ts
import { board } from '@vercel/board'
import { a2 } from '@vercel/board/backend-a2'
import { redisHttp } from '@vercel/board/backend-a2/store-redis-http'

const team = board({
  backend: a2({
    store: redisHttp({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! }),
  }),
})
export const GET = team.fetch, POST = team.fetch
```

There's nothing to apply: the keys appear as the board writes them. Each write
is one script that checks the log index and changes every key the event
touches, so it applies once or not at all. That needs one server, or a
provider without cluster mode, like Upstash.

On Upstash a script locks the whole database unless it opts out. board's and
A2's scripts lock only their own keys instead: every key of the board's tables
shares one hash tag, `{<keyPrefix>:board}`, and every key of an A2 session
shares that session's, so a script on one doesn't hold up the others. Reads
share their lock. A store asks the server once whether it takes Upstash's
`allow-key-locking` flag; Redis and Valkey don't, and run one command at a time
anyway. No script publishes.

| Option | What it does |
| --- | --- |
| `url` | `redis()`: the server, as `ioredis` takes it. `redisHttp()`: the REST endpoint |
| `token` | `redisHttp()`: the REST token |
| `client` | `redis()`, instead of `url`: an `ioredis` client you made, shared by A2 and the tables. Closing the store ends it |
| `keyPrefix` | Where the board's keys go, so boards can share a Redis. Default `a2`. It can't contain braces |

Redis keeps everything in memory: about 4 KB a message, counting the versions
`vb tail` and watchers read. A filter without an index, like `text`, reads
messages until it fills a page, a few thousand to a script, since Redis runs
nothing else while a script runs.

### Upgrading Redis to board 0.14

board 0.14 runs on A2 0.22, which names every Redis key differently, so a
board starts over: **point the store at a new `keyPrefix`**, then deploy. The
board starts with an empty log there, and never reads the old prefix's keys;
delete them whenever you like.

On a prefix that board 0.13 wrote, every request answers 503 `unavailable`:
`the redis keys under prefix '…' hold an A2 layout other than 'tagged-1'`.

A board that syncs starts over on each platform too. Its message IDs start
again from 1, and the threads it had on Slack or GitHub no longer map to board
threads. A new reply in one brings it over as a new board thread, its root
fetched from the platform; an edit or a reaction to an older message there
doesn't reach the board. Schedules live in the log, so create them again; a
board on `http()` registers its watchers again when it next starts, or on
`POST /watchers`.

## SQLite

`sqlite({ path })` keeps the log and the tables in one file, and creates the
tables when it opens. It's the store `a2()` uses when you pass none, and
`vb serve` keeps one in `.board/`. Delete the file and the board starts over.
board 0.14 makes event IDs unique per session in the file when it opens it, so
don't open that file with an earlier board afterwards.

## When a read sees a write

The tables apply each event right after it's written, so they're never far
behind. Three rules make that invisible:

- **A write answers once the tables hold it.** Any read after it sees it.
- **A read by message ID waits for that message.** `vb read 812`, a reply to
  #812, or a thread's page waits until the tables reach #812. An ID is a
  position in the log.
- **Lists answer at once.** `vb read dev`, `/messages`, and `/threads` return
  the tables as they are, with `cursor`: the log index they reflect. The
  [event feed](./05-reading.md) from that cursor on carries the rest. The
  first list on each instance also starts the tables catching up, so a deploy
  that adds them fills them from the log even before anyone writes.

On a board that already has a log, the first deploy with tables fills them from
it, a few round trips to the database an event. Until they reach the head, a
read by message ID waits for them, and a write waits up to 10 seconds, then
answers. Lists answer at once with what's there. A store whose tables came with
it, copied along with its log, doesn't wait: once the tables hold the whole
log, reads answer from them, while their consumer still reads the log behind
them.

## FAQ

### Postgres or Redis?

Either holds a board of any size, with the same reads. Pick the one your app
already runs. Postgres keeps the board on disk and reads unindexed filters with
its own planner; Redis keeps it in memory and needs no schema.

### Can I pass my own `pg` pool?

Yes: `postgres({ client: pool })`. A2 and the tables share it, so size it for
both. It has to be a pool, not one connection: each write takes a connection
of its own for its transaction.

### What runs the tables?

An A2 consumer named `board-tables`, on the board's log. If it ever stops on
an event, A2 dead-letters it, and reads by ID and writes wait on it: retry it
through A2, on the backend's `servers`, as soon as what failed is fixed.
