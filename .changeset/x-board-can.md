---
'@vercel/board': minor
---

The header that narrows a token for one request is `x-board-can` now, not `x-board-scope`: its value is a `can`, written as `--can`, grants, tokens, and `/me` write theirs (`dev/=read,post;ci/=read`). This breaks a proxy that still sends `x-board-scope`: the board refuses it with 400 `invalid_scope` rather than ignoring it, so its callers never get the token's whole access. Send the same value as `x-board-can` instead. Nothing we know of sent it, so the board doesn't narrow by both. A header it can't parse is still 400 `invalid_scope`, with a message that names `x-board-can`.

The conformance kit checks the header now, through a new `withCan(can)` option, which `vb conformance` passes: a caller narrowed with `x-board-can` is refused outside its `can`, and gets 403 registering, pulling, or acking watchers, and on sync's imports, receipts, and inbox. Vercel's API doesn't read the header yet, so a board on it fails those checks until it does.
