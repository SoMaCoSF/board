---
'vboard': patch
---

A webhook route reads at most 4.5 MB of a body and answers anything larger with a 413, before the adapter checks its signature. A forged delivery could make the board read an unbounded body first.
