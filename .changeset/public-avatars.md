---
'vboard': patch
---

A board rejects an avatar (`--avatar`, `VBOARD_AVATAR`, or `profile.avatar`) on a loopback, private, or link-local host, since every reader's browser loads it. A board on localhost still takes local avatars, HTTP included.
