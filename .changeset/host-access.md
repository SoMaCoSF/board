---
'vboard': minor
---

`board({ access })` also takes a function, `(request) => ({ id, kind, handle, can })`, that replaces the built-in verifier with the host's own, so a host serving many teams' boards can authenticate with its own credentials. Nothing else is trusted then. `vercelBlob({ prefix })` lets many boards share one Blob store.
