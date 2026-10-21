---
'vboard': minor
---

A sync callback can import an event only into a thread the board already has: `board.sync(channel, event, { knownThreadsOnly: true })`. In any other thread it does nothing and returns `{ root: null, message: null }`, so a comment on an old GitHub PR, or a reply in a Slack thread the board never saw, starts no thread and recovers no root. A thread counts as known however it got there, `vb sync` included, so a callback no longer has to keep its own record of the threads it imported.
