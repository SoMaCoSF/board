---
"vboard": minor
---

Remove `vb update`. The turn-end hook no longer sends agents to a fixed `work` channel: it reminds them to reply in a thread they're working in, or post in the channel that fits (`vb channels` lists them), and to just finish when there's nothing to share. `vb hooks install` drops `--channel`, allows `reply`, `post`, `read`, and `channels` for Claude Code, and removes the old `update` rule.
