---
'vboard': minor
---

`board()` is the handle on every board: one object that serves it and acts on it. Its methods are what the client's were (`post`, `reply`, `messages`, `wait`, `events`, …), acting as the board's caller, always through `board()`, which only calls the backend's methods: over `http()`, whoever its `fetch`'s credentials say, with the profile `VBOARD_AS` or the coding agent picks; on `a2()`, the board's own code, as `vboard:client`. `as(profile)` acts with another: `<principal>+<profile>` over HTTP, `vboard:client:<profile>` on `a2()`. With no backend, `board()` is `http()` to the board the environment points at, found as `vb` finds it: `VBOARD_URL`, the repo's link, or `vb use`'s, and its default `fetch` sends a token from `VBOARD_TOKEN`, `vb serve`, GitHub Actions, Vercel, or `vercel login`.

```ts
import { board } from 'vboard'

const team = board()
await team.as('deploys').post('deploys', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })
```

`vboard` and `vboard/backend-http` have a `node` build and a default one with nothing from Node, so a browser runs `board({ backend: http(url) })`, its `fetch` sending the page's own session for the board's `board({ authenticate })`, as the inspector's page now does with its per-run token. Sync loads when it's first used. Live events loop the backend's long-poll on every handle.

**Breaking:**

- `createClient` and `vboard/client` are gone: `board()` replaces them. `createClient()` becomes `board()`, `createClient({ url })` becomes `board({ backend: http(url) })`, and `createClient({ profile })` becomes `board().as(profile)`. Their types come from `vboard`. `detectAgent` isn't exported.
- `client(name, { key })` is gone: `as(name)` acts as that profile, and a post's own `id` makes it idempotent. The `id` is the handle's own, so no one can post with it first: over `http()` it goes as `key:<principal>:…`, and on `a2()` as an ID of the board's own kind.
- The handle has no `GET` or `POST`: `fetch` is its one handler. A route writes `export const GET = team.fetch, POST = team.fetch`.
- `http()` takes no `token`, `handle`, or `headers`: credentials go in `fetch`. In Node its default sends what `vb` does; in a browser, give it a `fetch` that sends the page's session, never a token of the deployment's.
- A board on `http()` keeps no discovery: with no `access` of its own, it answers only wake-ups, webhooks, and its sync's sign-ins, and `GET /` there is a 404. Discovery has no `remote`, `Backend` has no `remote` or `client`, and nothing follows a board to the one it uses: link the team's board (`vb link <its URL>`).
- `POST /identity/link` and `POST /identity/check` are gone, with the handle's `linkAccount` and `checkAccount`: `syncCode(key)` answers `{ code, expiresAt, signIn? }`, where `signIn` is the sign-in that carries the code, on the board that runs the entry's sync, and `identity()` shows the link once it's made. A board's own entries sign people in there too, and `identity()` says which entries are `unlinked`. `vb identity link --json` prints `{ sync, platform, code, expiresAt, signIn? }`.
- A source read (`readSource`, `GET /sources/:key/read`, `vb sources … read`) answers on the board that runs that entry, through its sync: `vb` reads the board it links. One that doesn't run it answers 404 `not_synced_here`. `vb typing` shows typing through the sync of the board it links too.
- `vb stuck`, `GET /stuck`, `POST /stuck/redrive`, and the handle's `stuck` and `redrive` are gone, with the `StuckEvent` type: a board on `a2()` keeps its dead letters in A2, reached through the backend's `servers`.
- The handle has no `source()`: `vb whoami` still says where its token came from. http()'s own `register()` is `registerWatchers()`, so a handle's `register()` is the protocol's.
- `{ kind: 'client' }`, a middleware's `source` for the handle's writes, has `name: null` for the handle itself, and the `Caller` for it has `self: null`. A caller from `as(profile)` also carries `profile`, what it asked for.
