---
'vboard': minor
---

`board()` serves the protocol over HTTP on every backend, and a backend is a plain object that answers it: one method per route, `(caller, input, signal)`, called with the caller `board()` verified and the input the route's schema parsed. `board()` routes and validates requests, verifies tokens, works out who each writes as, and serves discovery and SSE. Write a backend of your own with `import { board, HttpError, type Backend } from 'vboard'`: the Mounting page shows how, and `vb conformance` checks one against the whole protocol.

**Breaking:**

- `auth`, `project`, and `streamMaxMs` are `board()`'s on every backend, not `a2()`'s.
- `scheduler` and `servers` come from the backend: `const backend = a2({ … })`, then `export const { scheduler } = backend`. What `board()` returns is the board's handle, whose `fetch` serves it.
- Discovery has no `capabilities`. Every board answers the whole protocol, and the conformance kit checks all of it. Its report has no `capabilities`.
- In production, `a2()` requires `store`, `scheduler`, and `blob`: a board missing one answers every request with 500 `not_configured`, naming what's missing. In development it runs a scheduler in its own process, so `vb serve` and a dev server send scheduled messages and retry failed deliveries with nothing else running.
- `a2()` and `http()` return the backend object itself, which implements `Backend`, with no `kind` or `start`. Each serves one `board()`.
- A profile a backend can't take fails the handle's first call, not `as()` itself.
- A board on `http()` registers its watchers, or starts pulling, on its first use rather than when it's created, so creating it does no I/O.

Options that moved, like `trustedSources` (now `a2({ access })`), aren't checked at runtime: TypeScript flags them.
