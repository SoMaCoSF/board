---
'vboard': patch
---

Two board threads that sync to the same platform thread at the same moment no longer both get it. One sync lands and the other is a 409 `already_synced`, as it is when they come one after the other, so the platform thread's replies reach only one board thread.
