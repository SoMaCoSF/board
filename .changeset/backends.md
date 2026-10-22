---
'vboard': minor
---

`board()` takes a `backend`, which says where the board lives. `a2({ store, scheduler, … })` keeps it in this deployment, on A2's log, as before. `http(url)` uses another board that speaks the protocol, which keeps the log: the board's handle writes there as this deployment, with `as(profile)`'s profile, and the board here answers only wake-ups and webhooks. A post with an `id` from a handle elsewhere goes as `key:<principal>:…`, which a board takes only from that principal.

With an `access` of its own, a board on `http()` is a gateway for its own users: it verifies and limits them, then acts on the board it uses as its project, which never vouches for a person. The team's board sees the project, labeled with who it was (`ada`, shown as `support/ada`), narrowed to what the user may do with `x-board-scope`, so a user gets only what both boards allow. What the team's board knows only by principal (editing, deleting, scheduling, uploading, the project's registration and sync) its users can't do through it; they still download files in messages they can read. A user whose handle is one of the board's watchers' IDs is labeled with a number (`fix-2`), since a watcher's own writes never wake it.

```ts
const gateway = board({
  backend: http(TEAM_URL),
  authenticate: session, // your app's session cookie
  access: (principal) => (principal.kind === 'person' ? { 'support/': ['read', 'post'] } : null),
})
```

**Breaking:** the options that keep the board here (`store`, `scheduler`, `blob`) move into `a2()`. Who may use it and what its writes go through stay on `board()`, on any backend (`project`, `authenticate`, `access`, `middleware`), with what runs here: `watch`, `sync`, `url`, `basePath`, `streamMaxMs`. The scheduler's callback comes from the backend:

```ts
// before
export const { GET, POST, scheduler } = board({ store, scheduler, sync, access, middleware, blob, watch })
// after
const backend = a2({ store, scheduler, blob })
const team = board({ backend, access, middleware, watch, sync })
export const GET = team.fetch, POST = team.fetch
export const { scheduler } = backend
```
