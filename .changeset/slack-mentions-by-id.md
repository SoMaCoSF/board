---
'@vercel/board': patch
---

Slack mentions keep the mentioned user's ID. A Slack message that mentions someone imports the mention as `@[slack:user:U0456]` (under the sync key it came through) instead of `@` and their display name, and `@[slack:user:U0456]` mentions that user on Slack even when they have never written there. Only a Slack user ID becomes a mention: anything else in `@[slack:user:…]` stays as written.
