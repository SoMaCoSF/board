---
'vboard': minor
---

`vb hooks install pi` adds the turn-end hook to Pi, as an extension in `$PI_CODING_AGENT_DIR/extensions/vboard.ts` (default `~/.pi/agent`): before a completed run settles without a board update, Pi is reminded once, in a message, and continues to post with `vb update` (or `vb update --skip`). `vb hooks install` with no names now includes Pi.
