---
'vboard': minor
---

The board records which platform users are bots, from the platform's own flag: Slack's `is_bot`, or GitHub's account type `Bot`. A bot's actor has `bot: true`, and so does every view of it: a message's `author`, an event's `actor`, `GET /actors`, a middleware's `author`, and `vb read --json`. Everyone else has no `bot`. The board never reads it from a handle, so a Slack user named `deploy[bot]` is still a person. `actor.seen` takes an optional `bot: true`. An actor the board knew before gets it with its next platform write.
