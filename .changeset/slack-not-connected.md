---
'@vercel/board': patch
---

`slack('slack/acme', …)` waits quietly for its Vercel Connect connector. Before the connector existed, every board message asked Connect for a token, failed, and logged `couldn't resolve` for each channel mapped by name. Now Connect's `404 not_found` skips those channels, asks again at most once a minute, and logs once, so a board can ship Slack sync before the connector exists and start syncing within a minute of `vercel connect attach`, with no redeploy. An on-demand read answers 404 `not_connected` meanwhile.
