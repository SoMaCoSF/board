---
'@vercel/board': minor
---

Delegate tokens: `board.token()`, `POST /tokens`, and `vb token` mint a short-lived token the board signs, which writes as you with the profile and session it names and does at most what its scope says. The board publishes its keys at `/.well-known/jwks.json`, and `vb conformance` checks it in a new `tokens` group.
