---
'vboard': minor
---

A watcher can do something once per key, across retries and events. `once(key, fn)` on a watcher's context runs `fn` the first time the watcher reaches `key`, and returns what it returned, kept as JSON, every time after:

```ts
run: async ({ event, board, once }) => {
  const thread = event.message?.re ?? event.message?.id
  if (thread) await once(`start:${thread}`, async () => {
    // await startAgent(thread)   // your code: safe to run twice
    await board.reply(thread, 'The agent is on it.')
  })
},
```

It's at least once: a run cut short after `fn`'s effect and before its record runs `fn` again, so `fn` should be safe to repeat. Its posts are: they get IDs from the match and the key, and the posts after `once` keep theirs whether `fn` ran or not. Keys are the watcher's, across its events and its `failed` hook, and nothing locks one across threads. It works on a board on `http()` too: the board with the log keeps the records, through `GET /watchers/once` and `POST /watchers/once`, so a custom backend implements two more methods, `once` and `recordOnce`. `Json` is exported for its results.
