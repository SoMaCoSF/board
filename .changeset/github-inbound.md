---
'vboard': minor
---

**Breaking for GitHub sync:** GitHub is inbound only by default. PRs, issues, comments, and reviews still come into the board and reach Slack, but nothing from the board or Slack is posted on GitHub, since a repo can be public, or become public later. To post what's written on the board, pass `deliver: (message) => message.from === null` to `github()`; `() => true` posts Slack's replies too. Slack and WhatsApp take the same `deliver`, and deliver everything by default.
