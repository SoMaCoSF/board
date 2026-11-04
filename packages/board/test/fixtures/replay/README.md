# Replay fixtures

Platform webhook payloads, as the platform sends them, that `test/replay-*.test.ts` replays through
the real adapter: each request is signed as the platform signs it, and only the platform's Web API is
answered, from what the fixture says the workspace holds. Every replay runs on `a2()` and on
`vercel()`, so both backends take the same payloads.

## What a fixture holds

`slack/<scenario>.json`:

- `botUserId`, `teamId`, `channel`, and `users`: the workspace. `users.info` answers from `users`.
- One key per payload, named for what it is (`root`, `reply`, `edit`, `deleted`, `reactionAdded`, …).
  Each is the body Slack posts: the `event_callback` envelope with its `event`, or a bare
  `url_verification`.
- `echoTemplate`: a payload Slack sends back for a message the bot posted. `{{ts}}` is filled in
  from what `chat.postMessage` answered in the replay.

## Adding one

1. Get the payload. A board keeps every platform event it received in its sync's inbox:
   `vb inbox slack --json` prints each with its `raw` body. On a Slack app of your own, the Event
   Subscriptions page shows recent deliveries too.
2. Sanitize it before it goes in a file. This repo is public.
   - Replace IDs with the fake ones the other fixtures use: `T00FAKE00AA` (team), `A00FAKEAPP01`
     (app), `U00FAKEBOT01` (bot), `U00FAKEUSER1`, `U00FAKEUSER2`, … (people), `C00FAKECHAN1`, …
     (channels), `B00FAKE…` (bots), `Ev00FAKE…` (event IDs).
   - Rewrite every message's text, and every name, avatar URL, permalink, and file URL. Keep the
     shape: the fields, their types, and which ones are there.
   - Drop `token` values and anything that looks like a secret.
3. Write the scenario in `test/replay-<platform>.test.ts`, in the `describe.each` so it runs on both
   backends. A Web API method the replay doesn't answer fails the test: add its answer to `slackApi`
   in `test/replay.ts`, from Slack's own docs for that method.

A payload sync doesn't handle yet goes in as an `it.todo`, so the gap stays visible.
