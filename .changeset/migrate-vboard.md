---
"@vercel/board": minor
---

`migrateFromVboard({ store, clock, blob? })` from `@vercel/board/backend-a2` copies what a board on `vboard` 0.14 wrote into board's renamed sessions on the same store, so it keeps its history: messages, schedules, linked accounts, and registered watchers, with each event's ID, index, and time, its tables filled, and its files copied to `board/attachments/`. Nothing is synced or woken again. `replayClock()` is the clock to give the store for it, and `redisHttp()` and `sqlite()` take a `clock`.
