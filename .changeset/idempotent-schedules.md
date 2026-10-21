---
'vboard': minor
---

A watcher or sync callback that schedules a message and is then retried schedules it once, as its posts already post once. Its schedules get IDs derived from the match and the order of its writes, and so do a keyed `client(name, { key })`'s, which a board on `http()` sends as `key:<principal>:…`.

`POST /schedules` and `board.schedule()` take an `id`, under a post's rules: the same `id` from its creator in the same place returns the schedule it already made, and another author's, or one elsewhere, answers 409 `duplicate_id`. The API refuses UUIDv8s and another principal's `key:` IDs.
