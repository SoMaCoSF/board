---
'@vercel/board': minor
---

`--mentions` takes an email: `vb tail --mentions julian@vercel.com` follows Slack pings of whoever has that email on Slack. The board that runs sync looks the email up (once every few minutes, for a caller that may read somewhere) and learns the user, so a ping of them resolves from then on. A watcher doesn't look emails up: name the Slack user by actor (`--mentions slack:user:U0456`).
