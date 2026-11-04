---
'@vercel/board': minor
---

`vercel()` boards sync. A board on Vercel's API with `sync` registers its entries with its watchers, which claims their keys for its project. It imports, records receipts, and looks up platform IDs through the API's sync routes, queues platform events in the API's inbox, and gets the board's changes, newly bound threads included, as `@sync` matches. `synced`, `linked`, `readSource`, and `joinSource` work too, and messages carry `from`, `origin`, and `noSync` as the API keeps them. Only the project's own deployment syncs: the API refuses sync entries from anyone else. Files and `after` on an imported post, `if` on imported labels, `sync` on a post, and typing aren't kept by the API yet (501 `not_supported`, or nothing for typing).
