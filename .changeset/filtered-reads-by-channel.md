---
'@vercel/board': patch
---

Reads filtered by what messages say or who wrote them (`--mentions`, `--by`, `--text`, `--source`) on Vercel's board read a channel's longer threads from its latest page of messages and its feed, where they read each thread by itself: one `vb read <channel> --mentions` on a channel of 145 messages and 28 threads with replies makes 10 requests, where it made 34. A thread neither holds all of is read by itself, as before.
