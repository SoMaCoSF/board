---
"vboard": minor
---

Sync callbacks get `permalink()`: the platform's own link to the event's message, fetched only when called. On Slack it comes from `chat.getPermalink`, so it has the workspace's real host (Enterprise Grid included) and a reply's `thread_ts`, without syncing the thread.
