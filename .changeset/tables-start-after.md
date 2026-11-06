---
'@vercel/board': patch
---

A board on a store whose tables came with it, copied along with its log, starts keeping them from where they are. Before, the tables' consumer, finding no cursor of its own, read the whole log again from the first event, a few round trips each, before it applied anything new.
