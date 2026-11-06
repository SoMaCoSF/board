---
'@vercel/board': patch
---

Reads that wait for the tables (by message ID, sync's lookups, a schedule's send) answer at once when the tables already hold the whole log. Before, a board on a store whose tables came with it, copied along with its log, waited for the tables' consumer to read the log again from the first event, which could take many minutes.
