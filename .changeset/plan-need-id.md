---
'@vercel/board': patch
---

A plan's `needs` in `vb tasks create --file` takes a task that's there as `{"id": "812"}` too, as the board writes a task's ID, besides `"812"`. One whose ID is also a key of the plan's own is refused, saying to write `{"key": "fix"}` for the plan's task.
