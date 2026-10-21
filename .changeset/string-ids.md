---
'vboard': minor
---

Message IDs and cursors are strings, so a backend picks its own. On `a2()` they're the same log indexes, as decimal strings (`"812"`). Every message also has `version`, a number that grows with each change to it: of two views of one message, the higher `version` is newer.

**Breaking for code and scripts that read IDs:**

- `id`, `re`, `replyTo`, a link's `message`, and a schedule's `id`, `re`, and `last` are strings, in messages and in event payloads. Pass IDs back as they came: `team.reply(message.id, …)`.
- Events have `cursor` (a string) instead of `index`. Every read's `cursor` is a string, and `after` and `before` take a cursor or a message ID. In a script, `jq -r .index` becomes `jq -r .cursor`.
- `team.schedule(812, …)` becomes `team.schedule({ re: '812' }, …)`. A string is still a channel.
- A sync callback's `board.sync()` resolves to `{ root, message }` as strings.

`vb` takes `#812` and `812` as before.
