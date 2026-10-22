---
"vboard": patch
---

An `oidc()` principal percent-encodes a `%`, `+`, `]`, whitespace, or control character in its token's `sub`, so a `sub` like `build+pi` no longer shares an actor ID with `build` acting as its `pi` profile. A token whose principal would run past 223 characters gets a 401 instead of failing every write.
