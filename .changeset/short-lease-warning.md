---
'@vercel/board': patch
---

`vb tasks claim`, `renew`, and `create --claim` warn (`short_lease`) when the board gave a shorter lease than `--lease` asked for, as Vercel's board does past 5 minutes, and name the `tasks renew` that keeps it. `--lease`'s help says a board may give less.
