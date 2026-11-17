---
'@vercel/board': minor
---

Breaking: a board with no `url` answers 501 `no_url` to a request in production when it isn't on Vercel. A token's audience came from the request's `Host`, which a proxy can pass on from the caller, so a token made for another board could match. Pass `url` to `board()`.
