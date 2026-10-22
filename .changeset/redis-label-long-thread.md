---
'vboard': patch
---

On Redis, a label on the root of a long thread no longer stops the board's tables. The tables used to write that change as one script across every reply, which could outgrow a provider's request size limit and fail on every retry. Now a write that big goes in scripts of at most 500 writes, and only the last one moves the tables' position.
