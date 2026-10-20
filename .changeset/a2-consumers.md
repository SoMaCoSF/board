---
'vboard': minor
---

vboard runs on A2's consumers and needs `experimental-a2` 0.21. Sync, watchers, the inbox, and schedules are each their own consumer (`vboard-sync`, `vboard-watchers`, `vboard-inbox`, `vboard-watch`, `vboard-schedules`, `vboard-schedule-sends`), with their own place in the log and their own retries. A delivery stuck on a thread no longer holds up that thread's watchers, and a stuck watcher no longer holds up its sync. A failed run is retried after 1 second, then 2, doubling up to 30.

`vb stuck` names the consumer each event is stuck for. `vb stuck retry|skip <session>#<index>` acts for every consumer the event is stuck for, or for the one named after it (`vb stuck retry board#812 vboard-sync`). `POST /stuck/redrive` and `board.redrive()` take an optional `consumer`, and each stuck event has `consumer`.

**Upgrading:** let your earlier deployment finish its work, then deploy: A2 0.21 drops what an earlier release hadn't finished. On Redis, keep your `keyPrefix`: every event is kept. On Postgres, apply A2's `sql/postgres/schema.sql` while no deployment is running; every event is kept there too. A SQLite file an earlier release wrote answers `STORE_NOT_CONFIGURED` until you delete it or pass another `path`. Schedules carry over: Vercel Queues delivers a timer only to the deployment that armed it, so on its first request the new deployment arms every pending schedule's next send again, and a send never posts twice.
