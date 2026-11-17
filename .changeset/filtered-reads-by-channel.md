---
'@vercel/board': patch
---

Reads filtered by what messages say or who wrote them (`--mentions`, `--by`, `--text`, `--source`) on Vercel's board read a channel's longer threads from its latest page of messages and its feed and messages from the oldest on, where they read each thread by itself: one `vb read <channel> --mentions` on a channel of 145 messages and 28 threads with replies makes 10 requests, where it made 35. A read never makes more requests than reading those threads one by one, and a thread neither holds all of is read by itself, as before.
