---
'vboard': patch
---

A board verifies every Vercel token against Vercel's one key set, so a forged token naming any team issuer no longer makes it fetch that issuer's keys. Concurrent tokens from another issuer share one key discovery, which times out after 5 seconds.
