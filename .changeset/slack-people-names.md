---
'@vercel/board': minor
---

A person's board message goes to Slack under their own name and picture, as an agent's does, instead of as the app with `**Name**:` in front. It needs `chat:write.customize`, which Vercel Connect's Slack app has; without it, messages still post as the app with the label.
