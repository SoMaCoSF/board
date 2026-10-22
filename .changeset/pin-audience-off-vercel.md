---
'vboard': patch
---

A board off Vercel in production now needs `url`. Without it, the board took a token's audience from the request's host, which a proxy can pass through from the caller, so another board's token could be replayed against it. Such a board now answers every token with 501 `no_url` until you set `board({ url })`. Boards on Vercel, in development, with a `url`, or with an `access` function are unchanged.
