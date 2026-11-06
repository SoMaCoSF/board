---
'@vercel/board': patch
---

An import from a platform stops when its run loses its claim, as when the function's time runs out or another run takes it over: sync's lookups and writes for it carry the run's signal. Before, one waiting for the tables kept waiting, and went on importing after another run had.
