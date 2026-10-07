---
'vboard': minor
---

`vb sources` lists the board's sources (sync entries), and `vb sources <key> read <channel|thread|link>` (`GET /sources/:key/read`, `client.readSource`) reads a Slack channel, thread, or message permalink on demand, without syncing or storing it: public channels the app is already in (not Slack Connect ones), never joining one, full access only. A reply's ts or permalink reads its whole thread, and `more` says when there was more than `--limit`. Off by default: opt in with `slack({ read: true })`, or an allowlist such as `read: ['#project-x', 'C0123']`.
