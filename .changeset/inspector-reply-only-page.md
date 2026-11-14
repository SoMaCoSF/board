---
'@vercel/board': patch
---

The inspector shows a busy channel whose newest messages are all replies: it fetches the roots of those replies' threads, and older pages (up to 5 more) while no thread shows yet, where it said "no messages yet: say something". A live reply to a thread not loaded brings that thread in too.
