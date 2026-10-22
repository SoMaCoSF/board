---
title: Database
description: "Where a board keeps everything: Postgres or Redis in production, SQLite in development, memory in tests."
---

## Pick a store

```package-install
npm i vboard pg
```

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { postgres } from 'vboard/store-postgres'

export const { GET, POST } = board({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
})
```

| Store | From | For |
| --- | --- | --- |
| `postgres({ connectionString })` | `vboard/store-postgres` | production; needs `pg` |
| `redis({ url })` | `vboard/store-redis` | production, on Redis over TCP; needs `ioredis` |
| `redisHttp({ url, token })` | `vboard/store-redis-http` | production, on Upstash's REST API; needs nothing |
| `sqlite({ path })` | `vboard/store-sqlite` | development and `vb serve`; `path` defaults to `.a2/dev.db` |
| `memory({ clock })` | `vboard/store-memory` | tests |

Leave `store` out and the board picks for you: SQLite at `.a2/dev.db` in
development, memory in tests. In production it doesn't start without one.

## What a store keeps

One database holds two things:

- **The log.** Every board fact is an event in one A2 session, `board`, in
  A2's tables (`a2_*`). It's the truth: nothing else is written directly.
- **The tables.** vboard keeps its own tables (`vboard_*`) from the log, one
  event at a time, in order, and reads from them.

| Table | Holds |
| --- | --- |
| `vboard_messages` | each message as it is now, with the columns filters use; a root's row also holds its reply count and its latest reply |
| `vboard_versions` | each message after every event that changed it, so `vb tail` and watchers can show a change before and after |
| `vboard_terms` | labels and mentions, so `--label` and `--mentions` are an index lookup |
| `vboard_sync_threads`, `vboard_copies` | where each thread and message lives on each platform: a thread's targets and the platform thread on each, a message's copy on each |
| `vboard_external_threads`, `vboard_external_messages` | the other way: which board thread and message a platform's thread and message are |
| `vboard_positions` | the last log index the tables applied |

On Redis the tables are hashes and sorted sets under `<keyPrefix>:vboard`, with
a sorted set for each channel, thread, author, mention, and label, so the same
filters are a lookup there too.

A post, a reply, a thread, and a channel's list of threads cost the same on a
board of a hundred messages or a hundred thousand. Other lists stop as soon as
they fill a page, so a filter that matches often is as fast. One that matches
rarely, and `/threads` filtered by more than a channel, read further into the
board to answer.

## Postgres

Neither A2 nor vboard creates tables in Postgres. Apply one file, once per
database, before the first deploy:

```bash
psql "$DATABASE_URL" -f node_modules/vboard/sql/postgres/schema.sql
```

`schema.sql` holds A2's tables, then vboard's. Every statement creates only
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
await client.query(readFileSync('node_modules/vboard/sql/postgres/schema.sql', 'utf8'))
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
| `connectionString` | The database. A2 opens its own pool on it, and vboard another |
| `client` | Instead of `connectionString`: a `pg` Pool you made, shared by A2 and vboard. For a password that comes from a callback, say. Closing the store ends it |
| `listenConnectionString` | A direct connection, for live updates by notification instead of polling. Apply `node_modules/vboard/sql/postgres/notifications.sql` too |
| `max` | With `connectionString`: how many connections vboard's own pool opens. Default 5 |

A vboard release that changes the tables says so in its changelog: apply that
release's `schema.sql` before you deploy it.

## Redis

```package-install
npm i vboard ioredis
```

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { redis } from 'vboard/store-redis'

export const { GET, POST } = board({
  store: redis({ url: process.env.REDIS_URL! }),
})
```

On Upstash, or anywhere a function can't keep a connection open, use its REST
API instead. It needs no package:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { redisHttp } from 'vboard/store-redis-http'

export const { GET, POST } = board({
  store: redisHttp({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! }),
})
```

There's nothing to apply: the keys appear as the board writes them. Each write
is one script that checks the log index and changes every key the event
touches, so it applies once or not at all. That needs one server, or a
provider without cluster mode, like Upstash.

| Option | What it does |
| --- | --- |
| `url` | `redis()`: the server, as `ioredis` takes it. `redisHttp()`: the REST endpoint |
| `token` | `redisHttp()`: the REST token |
| `client` | `redis()`, instead of `url`: an `ioredis` client you made, shared by A2 and the tables. Closing the store ends it |
| `keyPrefix` | Where the board's keys go, so boards can share a Redis. Default `a2` |

Redis keeps everything in memory: about 4 KB a message, counting the versions
`vb tail` and watchers read. A filter without an index, like `text`, reads
messages until it fills a page, a few thousand to a script, since Redis runs
nothing else while a script runs.

## SQLite

`sqlite({ path })` keeps the log and the tables in one file, and creates the
tables when it opens. `vb serve` keeps one in `.vboard/`. Delete the file and
the board starts over.

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
answers. Lists answer at once with what's there.

## FAQ

### Postgres or Redis?

Either holds a board of any size, with the same reads. Pick the one your app
already runs. Postgres keeps the board on disk and reads unindexed filters with
its own planner; Redis keeps it in memory and needs no schema.

### Can previews share production's database?

Not safely. A preview runs whatever a branch pushed, and a credential reaches
the whole database: Redis's `keyPrefix` only says where the board's keys go.
Connect production's database to Production only, and give previews their own:
a Neon branch each, or a second Upstash database.

### Can I pass my own `pg` pool?

Yes: `postgres({ client: pool })`. A2 and the tables share it, so size it for
both. It has to be a pool, not one connection: each write takes a connection
of its own for its transaction.

### What runs the tables?

An A2 consumer named `vboard-tables`, on the board's log. If it ever stops on
an event, `vb stuck` lists it first. Reads by ID and writes wait on it, so retry
it as soon as what failed is fixed.
