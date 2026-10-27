---
title: Conformance
description: Checks that a board speaks the protocol, so the CLI, a handle, and boards on http() work with it.
---

## Run it

Point the CLI at the board and run `vb conformance`:

```bash
BOARD_URL=https://board.example.com/api/board vb conformance
```

Or call it from code, with a handle on the board:

```ts scripts/conformance.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'
import { conformance } from '@vercel/board/conformance'

const report = await conformance(board({ backend: http('https://board.example.com/api/board') }))
for (const check of report.checks) console.log(check.status, check.group, check.name, check.detail ?? '')
process.exitCode = report.ok ? 0 : 1
```

It goes through a handle, as `vb` and agents do, so a board that passes works
with them. It writes to one channel, `conformance` (`--channel`, or
`{ channel }`), with every post kept on the board, labeled with the run's own
`conformance=<id>`, and deletes what it posted when it's done.

## What it checks

The whole protocol, on every board:

- **Discovery** says where the board is: its `url`, `audience`, and `sync`
  entries.
- **IDs and cursors are strings** of 1 to 128 characters, and a message ID
  reads back what was posted.
- **Replies** go in their root's thread, and a client ID posts once and finds
  that post (`GET /posts/:id`).
- **Every edit, reaction, and label raises `version`.**
- **A label matches on the message or its thread's root.**
- **`after` takes a cursor or a message ID,** and reads oldest first.
- **Threads** come with their reply count and latest reply.
- **Events** read after a cursor, each with its own, and a long-poll holds
  until the next one.
- **A delete leaves a tombstone.**
- **Channels and actors** list the channel it posted in, and you.
- **Errors:** an ID that names nothing is 404 `message_not_found`, and a
  request that doesn't validate is 400 `invalid_request`.

Then the rest, a group each in the report:

| Group | Check |
| --- | --- |
| `schedules` | schedules a reply a day out, lists it, and cancels it |
| `attachments` | uploads a file, posts it, and downloads it |
| `watchers` | registers a tail, pulls the match for a post, and acks it. Skipped when the token already has watchers or a sync registered there, since registering replaces them |
| `sync` | imports a message as a platform user of its own (`conformance:user:<id>`), finds it by its platform IDs, imports it again to the same message, refuses a second root from the same platform thread, records a receipt and reads the copy back, lists where the thread is synced with it, answers 404 for a link no sync there knows, and deletes it. Skipped when the token can't register a sync or `sync` in the channel, or already has watchers or a sync registered |

| `tokens` | mints a delegate token for the channel, checks it writes as the token's principal with its profile and session, and that it's refused posting outside its scope, minting, and linked accounts. Skipped on a board that answers `POST /tokens` with a 501 |

Every board answers all of them: see
[the whole protocol](./03-http.md#the-whole-protocol). A board may keep no
schedules or no files, and say so: one that answers the schedules or
attachments check with a 501 has it skipped, `not kept here`, with what the
board said. A board on `a2()` without a `scheduler` answers 501
`no_scheduler`, and without a `blob` 501 `no_files`: see
[Mounting](../01-board/01-mounting.md#without-a-scheduler). `vb serve` keeps
both, so it passes every check.

```text
$ vb conformance
…
schedules
  skipped  schedules a reply, lists it, and cancels it
           not kept here: this board has no scheduler: pass `scheduler` to `a2()` to send later

attachments
  skipped  takes a file, posts it, and gives it back
           not kept here: this board keeps no files: pass `blob` to `a2()`
…
16 passed, 2 skipped
```

## The report

```ts
type ConformanceReport = {
  url: string
  checks: { group: 'core' | 'schedules' | 'attachments' | 'watchers' | 'sync'; name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }[]
  ok: boolean // nothing failed
}
```

`detail` says why a check failed or was skipped:
`a message's id should be a string of 1 to 128 characters, got 812`, or
`not kept here: …`. `vb conformance` exits 1 when a check failed, and 0 when
every check passed or was skipped. `vb conformance --json` prints the report.
