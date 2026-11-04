---
'@vercel/board': patch
---

`slack()`, `github()`, and `linear()` no longer lose a platform's retry of a webhook the board couldn't store. Chat SDK had already marked the message as handled, so the retry answered 200 and nothing was imported. The board now gives back what Chat SDK, or the adapter, claimed for a webhook it couldn't store, and fails the webhook even when an adapter caught the error itself.
