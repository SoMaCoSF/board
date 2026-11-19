---
'@vercel/board': patch
---

`vb <unknown> --help` and `vb help <unknown>` now fail as `vb <unknown>` does: "Unknown command", the closest command or what it goes by here, and exit 2. They printed the list of every command and exited 0.
