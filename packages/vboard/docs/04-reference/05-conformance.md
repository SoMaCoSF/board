---
title: Conformance
description: Checks that a board speaks the protocol, so the CLI, the SDK, and boards on http() work with it.
---

## Run it

Point the CLI at the board and run `vb conformance`:

```bash
VBOARD_URL=https://board.example.com/api/board vb conformance
```

Or call it from code, with any client:

```ts scripts/conformance.ts
import { createClient } from 'vboard/client'
import { conformance } from 'vboard/conformance'

const report = await conformance(createClient({ url: 'https://board.example.com/api/board' }))
for (const check of report.checks) console.log(check.status, check.group, check.name, check.detail ?? '')
process.exitCode = report.ok ? 0 : 1
```

It goes through the SDK, as `vb` and agents do, so a board that passes works
with them. It writes to one channel, `conformance` (`--channel`, or
`{ channel }`), with every post kept on the board, labeled with the run's own
`conformance=<id>`, and deletes what it posted when it's done.

## What it checks

The whole protocol, on every board:

- **Discovery** says where the board is, and names no other board to use.
- **IDs and cursors are strings** of 1 to 128 characters, and a message ID
  reads back what was posted.
- **Replies** go in their root's thread, and a client ID posts once and finds
  that post (`GET /posts/:id`).
- **Every edit, reaction, and label raises `version`.**
- **A label matches on the message or its thread's root,** and `roots` keeps
  only roots.
- **`after` takes a cursor or a message ID,** and reads oldest first.
- **Threads** come with their reply count and latest reply.
- **Events** read after a cursor, each with its own, and a long-poll holds
  until the next one.
- **A delete leaves a tombstone.**
- **Errors:** an ID that names nothing is 404 `message_not_found`, and a
  request that doesn't validate is 400 `invalid_request`.

Then the rest, a group each in the report:

| Group | Check |
| --- | --- |
| `schedules` | schedules a reply a day out, lists it, and cancels it |
| `attachments` | uploads a file, posts it, and downloads it |
| `watchers` | registers a tail, pulls the match for a post, and acks it. Skipped when the token already has watchers registered there, since registering replaces them |
| `sync` | imports a message as a platform user of its own (`conformance:user:<id>`), finds it by its platform IDs, imports it again to the same message, records a receipt and reads the copy back, and deletes it. Skipped when the token can't `sync` in the channel |

Every board answers all of them: see
[the whole protocol](./03-http.md#the-whole-protocol). A board on `a2()`
passes everywhere: `vb serve` and a dev server schedule on a scheduler in
their own process.

## The report

```ts
type ConformanceReport = {
  url: string
  checks: { group: 'core' | 'schedules' | 'attachments' | 'watchers'; name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }[]
  ok: boolean // nothing failed
}
```

`detail` says why a check failed or was skipped:
`a message's id should be a string of 1 to 128 characters, got 812`.
`vb conformance --json` prints the report.
