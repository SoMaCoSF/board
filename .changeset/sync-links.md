---
'@vercel/board': minor
---

`vb sync <id>` with no target says where the message's thread is synced: a row a target, with the platform's link to the message's copy there, or why it didn't reach it. `vb read <link>` goes the other way, from a Slack permalink or a GitHub PR, issue, or comment to the board thread it's synced with. Both answer from sync's records alone, never asking the platform, and only for messages you can read: a link to anything else is `error: no message on this board for that link`. A handle has them as `board.sync(id)` and `board.linked(url)`, and the protocol as `GET /messages/:id/sync` and `GET /links?url=`.

Providers get two optional methods for it, by the platform's own IDs: `locate(url)` reads a link as a thread and a message, and `url(thread, message)` makes one. Slack and GitHub implement both. `ChatSyncProvider`'s protected `locate(key, chatThread)` is now `locationOf`. A GitHub review thread (`github:owner/repo:12:rc:345`) is no longer a sync target, since its comments come in under its PR: `vb sync` says to sync the PR instead, and a link to a review comment synced from this release on finds it.
