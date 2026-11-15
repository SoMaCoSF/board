---
"@vercel/board": patch
---

On Vercel's board, `vb read --by <handle>` from a caller held to some channels says the API refused it the board's actors, which a handle needs, and to name them by actor ID or `--by me`, where it said "You can't read <channel>" of a channel it can read.
