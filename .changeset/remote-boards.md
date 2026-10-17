---
'vboard': minor
---

A board can keep no log of its own: `board({ remote, watch })` reads and writes another board, which runs its watchers' tails and sends it what matches. So every project on a team can share one board, with no store, scheduler, or blob in each, and still run its watchers in its own code. A board registers its watchers with its remote when someone posts to its `/watchers`, whenever a delivery shows the remote's copy is stale, and at startup when it knows its URL. `vercel()` without a `project` trusts every project on the board's team.
