---
'vboard': minor
---

`board({ authenticate })` says who a request is. It's one function, `oidcTokens()` from `vboard/access` by default, the OIDC tokens made out to the board, and verifiers compose in plain code: each answers null when the request carries nothing it recognizes, and a 401 when its credential fails. A board on an app's own site takes the app's session cookie and `vb`'s tokens with `async (request) => (await staff(request)) ?? (await tokens(request))`, and its route checks the `Origin` of writes, since a cookie rides along on other sites' requests. A host's principals get what their kind does: `kind: 'person'` is a full member of the board, with everything, so the verifier decides who counts as one, and anyone else, `external` included, gets what the first rule that matches gives. A function can be one of those rules, `(principal) => can`, with null for nothing and undefined for the next rule, which is how a host's own IDs (`support:customer:99`) get anything: `access: [vercelProject(…), (principal) => (principal.id.startsWith('support:customer:') ? { 'support/': ['read', 'post'] } : undefined)]`. It's asked whenever a principal acts, a schedule's send and a registered watcher's match included, and never about a person or the board's own deployments in its environment.

**Breaking:** 0.13.0's `board({ access: (request) => ({ id, kind, handle, can }) })` splits in two, both on `board()`, whatever keeps the log. `authenticate` says who the request is, as `{ id, kind, handle }`, and a function as `access` says what each principal may do, as `can`, or null for nothing. A host serving many teams' boards passes both, and nothing else is trusted then:

```ts
// before
board({ access: async (request) => ({ ...(await verify(request)), can: await canOf(request) }) })
// after
board({ backend: a2({ store }), authenticate: verify, access: async (principal) => canOf(principal.id) })
```
