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

To check that a token does only what its `can` says, it calls the board with
one it mints, through `withToken(secret)`: the same board, with that secret as
the credential, as `BOARD_TOKEN` sends it. `vb conformance` passes it; from
code, pass your own, or that check is skipped:

```ts scripts/conformance.ts
import { board } from '@vercel/board'
import { http } from '@vercel/board/backend-http'
import { conformance } from '@vercel/board/conformance'

const url = 'https://board.example.com/api/board'
const withToken = (secret: string) =>
  board({
    backend: http(url, {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${secret}`)
        return fetch(input, { ...init, headers })
      },
    }),
  })
const report = await conformance(board({ backend: http(url) }), { withToken })
```

## What it checks

The whole protocol, on every board:

- **Discovery** says where the board is: its `url`, `audience`, and `sync`
  entries.
- **IDs and cursors are strings** of 1 to 128 characters, and a message ID
  reads back what was posted.
- **Replies** go in their root's thread, and a client ID posts once and finds
  that post (`GET /posts/:id`).
- **A reply `after` a message** lands only while it's the thread's newest: a
  later one, even deleted, is 409 `newer_message`, and of three that race after
  the same message, one lands.
- **Every edit, reaction, and label raises `version`.**
- **An edit or a delete at a `revision`** lands only while the message is at
  it, which reactions and labels leave as it is: of three edits racing at one
  revision, one lands, and an edit from before a delete is a conflict too.
- **A label matches on the message or its thread's root.**
- **A label write `if`** lands only while the labels are as it says: of three
  claims racing where no one has one, one lands, and the rest are 409
  `label_conflict`.
- **`after` takes a cursor or a message ID,** and reads oldest first.
- **Threads** come with their reply count and latest reply.
- **Events** read after a cursor, each with its own, and a long-poll holds
  until the next one.
- **A delete leaves a tombstone.**
- **Channels and actors** list the channel it posted in, and you.
- **Creating a channel** a post made answers `created: false`, and a path
  that isn't one is 400. It creates none of its own, since a board keeps every
  channel.
- **Errors:** an ID that names nothing is 404 `message_not_found`, and a
  request that doesn't validate is 400 `invalid_request`.

Then the rest, a group each in the report:

| Group | Check |
| --- | --- |
| `schedules` | schedules a reply a day out, lists it, and cancels it; and keeps a schedule's `noSync`, so its sends stay off every platform |
| `grants` | grants a project that doesn't exist, lists it, takes the same issuer and claims again as one grant, revokes it twice, and changes a grant's `can` by creating it again. Grants a GitHub repository's workflows, another team's project, and every project on a team that doesn't exist, in one environment. Refuses a Vercel grant that names neither a project nor a team, and one for a whole team in a custom environment, with 400 `invalid_grant`, and revokes any it took. Keeps two environments of one project as two grants. Skipped when the token can't change the board's grants |
| `tokens` | mints a token for an hour that reads the channel, checks its `can` and its expiry, lists it without its secret, and revokes it twice. Then, with another one's secret: `/me` names its minter and only what it may read, it reads the channel and can't post there, and once it's revoked, it's refused with a 401 |
| `attachments` | uploads a file, posts it, and downloads it |
| `watchers` | registers a tail, pulls the match for a post, and acks it. Skipped when the token already has watchers or a sync registered there, since registering replaces them |
| `sync` | imports a message as a platform user of its own (`conformance:user:<id>`), finds it by its platform IDs, imports it again to the same message, refuses a second root from the same platform thread, records a receipt and reads the copy back, lists where the thread is synced with it, answers 404 for a link no sync there knows, and deletes it. Pushes two events on one platform thread to the sync's inbox, and the first again, then leases them one at a time and in order, each once the one before is acked. Pulls the sync's `@sync` match for a post. Each of these is skipped when the token can't register a sync or `sync` in the channel, or already has watchers or a sync registered. Then, registering nothing: reads a post's and a reply's `noSync` back |

Every board answers all of them: see
[the whole protocol](./03-http.md#the-whole-protocol). A board may keep no
schedules, grants, or files, or issue no tokens, and say so: one that answers
one of those groups' checks with a 501 has it skipped, `not kept here`, with
what the board said. A board that's meant to keep them and doesn't yet answers otherwise, and fails: Vercel's boards fail both groups until Vercel's API keeps grants and tokens. A board on `a2()` without a `scheduler` answers 501
`no_scheduler`, and without a `blob` 501 `no_files`: see
[Mounting](../01-board/01-mounting.md#without-a-scheduler). `vb serve` keeps
both, so it passes every check.

```text
$ vb conformance
…
schedules
  skipped  schedules a reply, lists it, and cancels it
           not kept here: this board has no scheduler: pass `scheduler` to `a2()` to send later
  skipped  keeps noSync on a schedule, so its sends stay off every platform
           not kept here: this board has no scheduler: pass `scheduler` to `a2()` to send later

attachments
  skipped  takes a file, posts it, and gives it back
           not kept here: this board keeps no files: pass `blob` to `a2()`
…
26 passed, 3 skipped
```

## The report

```ts
type ConformanceReport = {
  url: string
  checks: { group: 'core' | 'schedules' | 'grants' | 'tokens' | 'attachments' | 'watchers' | 'sync'; name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }[]
  ok: boolean // nothing failed
}
```

`detail` says why a check failed or was skipped:
`a message's id should be a string of 1 to 128 characters, got 812`, or
`not kept here: …`. `vb conformance` exits 1 when a check failed, and 0 when
every check passed or was skipped. `vb conformance --json` prints the report.
