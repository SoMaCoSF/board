---
'vboard': minor
---

A watcher can say when it gives up on an event. Its optional `failed` hook runs once, after `run` kept throwing (5 tries) or kept getting cut short (10), with the event, `board`, `error`, and `attempts`:

```ts
failed: async ({ event, board, error }) => {
  if (event.message) await board.reply(event.message.re ?? event.message.id, `couldn't start: ${error}`)
},
```

Its posts get IDs of their own, so they never land on one `run` made. A hook that throws is recorded as `watch.failed`'s `hook`, and the thread goes on. It runs on a board on `http()` too: after 5 tries the board with the log hands the match out once more with `failed`, and acking it records `watch.failed`.
