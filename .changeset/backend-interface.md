---
'vboard': minor
---

`board()` serves the protocol over HTTP on every backend, and a backend is a plain object that answers it: one method per route, `(caller, input, signal)`, called with the caller `board()` verified and the input the route's schema parsed. `board()` owns the policy, in one place on any backend: it verifies each request's caller, works out who it writes as, applies `access`, and runs the middleware, before anything else runs for it. It also serves SSE and discovery, and runs watchers and sync. A backend stores and answers, honoring what each caller may do, and asks `board()` through its binding about the principals it stores, at each schedule's send and each registered watcher's match. Write a backend of your own with `import { board, HttpError, type Backend } from 'vboard'`: the Mounting and Access pages show how, and `vb conformance` checks one against the whole protocol.

**Breaking:**

- `board()` takes `backend`, `authenticate`, `access`, `middleware`, `project`, `watch`, `sync`, `url`, `basePath`, and `streamMaxMs`. `store`, `scheduler`, and `blob` are `a2()`'s, which is the log and its engine.
- `auth` is gone: its options go to `oidcTokens()` from `vboard/access`, `board()`'s default `authenticate`. `vb serve` passes `oidcTokens({ local })`, and tests `oidcTokens({ vercel, github, oidc })`.
- A backend's `Caller` is `{ identity: { principal, author, actor }, origin }`, one `board()` verified, whose principal carries its `access`, or `{ self, origin }`, this deployment's own code. A backend trusts the first as it is: only `board()` makes one, in process. `Backend` has `keeps`, whether the board lives there: on one that doesn't (`http()`), `board()` serves no request but wake-ups and webhooks unless it has an `access` of its own. `BackendRoute` has no `auth`: `board()` verifies nothing for a backend's own routes, whose `caller` is null for a request. `BoardBinding` has `readSource()`, `typing()`, `accessNow(principal)`, `project()`, and `handle(caller)`, through which a backend writes for someone (a schedule's send, as its creator) so the middleware sees it.
- Typing and source reads are protocol methods (`typing`, `readSource`), which a backend answers: `a2()` through the sync `board()` runs beside it. So is `discovery`, for a handle: a request's discovery is `board()`'s, with the sync entries the backend lists.
- `scheduler` and `servers` come from the backend: `const backend = a2({ … })`, then `export const { scheduler } = backend`. What `board()` returns is the board's handle, whose `fetch` serves it.
- Discovery has no `capabilities`. Every board answers the whole protocol, and the conformance kit checks all of it. Its report has no `capabilities`.
- In production, `a2()` requires `store`, `scheduler`, and `blob`: a board missing one answers every request with 500 `not_configured`, naming what's missing. In development it runs a scheduler in its own process, so `vb serve` and a dev server send scheduled messages and retry failed deliveries with nothing else running.
- `a2()` and `http()` return the backend object itself, which implements `Backend`, with no `kind` or `start`. Each serves one `board()`.
- A profile a backend can't take fails the handle's first call, not `as()` itself.
- A board on `http()` registers its watchers, or starts pulling, on its first use rather than when it's created, so creating it does no I/O.

Options that moved, like `trustedSources` (now `board({ access })`), aren't checked at runtime: TypeScript flags them.
