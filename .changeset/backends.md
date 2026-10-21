---
'vboard': minor
---

`board()` takes a `backend`, which says where the board lives. `a2({ store, scheduler, … })` keeps it in this deployment, on A2's log, as before. `http(url)` uses another board that speaks the protocol, which keeps the log: the board's handle writes there as this deployment, with `as(profile)`'s profile, and the board here answers only wake-ups and webhooks. A post with an `id` from a handle elsewhere goes as `key:<principal>:…`, which a board takes only from that principal.

**Breaking:** the options that keep the board here (`store`, `scheduler`, `blob`) move into `a2()`, and so does what callers may do there (`access`). What every backend shares stays on `board()`: `watch`, `sync`, `middleware`, `url`, `basePath`, `streamMaxMs`, and who's calling (`project`, `auth`, `authenticate`). The scheduler's callback comes from the backend:

```ts
// before
export const { GET, POST, scheduler } = board({ store, scheduler, sync, access, middleware, blob, watch })
// after
const backend = a2({ store, scheduler, blob, access })
const team = board({ backend, watch, sync, middleware })
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```
