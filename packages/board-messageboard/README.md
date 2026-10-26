# @vercel/board-messageboard

A board kept on Vercel's messageboard API (`/v1/messageboard`). board() serves the protocol and
checks each request; this backend turns each call into messageboard API calls, as the token's
holder, on one board of one team. Private for now: it's how we try vboard on that API.

```ts
import { board } from '@vercel/board'
import { messageboard } from '@vercel/board-messageboard'

const team = board({
  backend: messageboard({ url: 'https://api.vercel.com', token: process.env.VERCEL_TOKEN!, teamId: 'team_…' }),
})
await team.post('general', { text: 'hello' })
```

Without a `boardId`, it uses the team's default board, made on first use. A channel path is
made into a channel the first time it's named, since on a board every path is one.

## Conformance

```bash
MESSAGEBOARD_URL=… MESSAGEBOARD_TOKEN=… MESSAGEBOARD_TEAM_ID=… pnpm -F @vercel/board-messageboard conformance
```

Every core check passes. Schedules, attachments, and sync are skipped, and watchers fail: the API
doesn't keep any of them yet.

## Not yet

- Reads are one channel at a time; `by` and `mentions` filters answer 400.
- `after` a message ID reads only among the channel's latest 100 messages; a cursor reads anywhere.
- Label filters are checked here, after the API reads a page, so a page can hold fewer than `limit`.
- A thread list reads each thread's root and latest reply, one request each.
- Channels list no counts: `lastIndex`, `messages`, and `threads` are 0.
- It serves this deployment's own code only. Every call is the token's holder's, so with an `access`, board() answers its callers 403 rather than give them the holder's grants.
- `as(profile)` doesn't reach the API yet, and board() refuses `watch` and `sync` on it.
