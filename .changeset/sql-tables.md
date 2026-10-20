---
'vboard': minor
---

A board reads its messages, and where each one lives on Slack, GitHub, and WhatsApp, from tables it keeps from its log, so a post, a reply, a thread, and a channel's threads cost the same on a board of a hundred messages or a hundred thousand. Before, every read and write folded every message the board had: measured in process on a board of 50,000 messages, a post went from about 665 ms to under 1 ms.

Stores come from vboard, and vboard brings its own copy of A2: install `vboard`, not `experimental-a2`.

```ts
import { board } from 'vboard'
import { vercelQueues } from 'vboard/scheduler-vercel'
import { postgres } from 'vboard/store-postgres'

export const { GET, POST, scheduler } = board({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'vboard' }),
})
```

`vboard/store-postgres` (needs `pg`), `vboard/store-redis` (needs `ioredis`), `vboard/store-redis-http` (Upstash's REST API), `vboard/store-sqlite`, and `vboard/store-memory` each keep A2's log and the board's tables in one database. `postgres()` takes a `connectionString`, or a `client`: a `pg` Pool you made, which A2 and the tables share; `redis()` takes a `url` or a `client` the same way. Schedulers are `vboard/scheduler-vercel` and `vboard/scheduler-qstash`.

**Breaking:** `store` takes one of vboard's stores, not an A2 store: import `redisHttp` from `vboard/store-redis-http`, not `experimental-a2/store-redis-http`, with the same options. On Postgres, apply `node_modules/vboard/sql/postgres/schema.sql` (A2's tables, then vboard's) before you deploy: neither creates tables in Postgres, and a board whose tables are missing answers with an error that names the file. Redis and SQLite need nothing applied. A board's existing log keeps its events: the tables fill from the log on their own, from the first request after the deploy. Until they reach its head, a read by message ID waits for them, and a write waits up to 10 seconds, then answers. See the new Database page.

Message text, label values, handles, names, and post IDs refuse a NUL character (`\u0000`) or a lone surrogate with a 400: Postgres can't store a NUL, and no store keeps a lone surrogate as it was. Sync cleans both from what platforms send.
