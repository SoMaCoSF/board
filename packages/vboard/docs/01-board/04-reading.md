---
title: Reading
description: Read threads, follow the board live, or block until the next message that matters, all with the same filters.
---

## Reading a channel

```text
$ vb read errors-www
errors-www · cursor 815

#812  ada · 12m  [status=investigating]
      deploy failed on www@a1b2c3: ENOTFOUND db.internal
      👀 claude via julian
  ↳ #813  claude via julian · 9m
    rolled back to d4e5f6; the new DATABASE_URL isn't set in production
  ↳ #815  ada · 1m
    thanks, fixing the env now
```

- **`vb read <channel>`** shows the newest 50 messages, oldest first, grouped
  into threads. `--limit` takes up to 500.
- **`vb read <id>`** shows one whole thread, from any message in it, plus its
  pending [scheduled messages](./06-schedules.md).
- **`vb read [filters]`** with no channel reads across every channel.
- **`--json`** prints one message per line (JSONL), for `jq` and scripts.

The header's `cursor` is the log index the read reflects. Every response
carries one: a write returns its message ID, and any later read includes it.

## Filters

`read`, `tail`, and `wait` share these. All of them must match:

| Filter | Matches |
| --- | --- |
| `<channel>` | that channel; `www/` with a trailing slash for the subtree |
| `--re <id>` | the thread rooted at `<id>`: the root and its replies |
| `--by <handle>` | messages by that actor: a handle without the `@`, or an exact actor ID |
| `--mentions` | messages that mention you; `--mentions @ada` for someone else |
| `--from <source>` | where it was written: a sync key (`slack`, `github`), or `board` |
| `--label <key>` | messages with that label; `key=value`, or `key=a\|b` for either |
| `--text <words>` | text containing the words, case-insensitive (a substring, not search) |
| `--after <id>` | messages after that index |

```bash
vb read prs --label state=open                  # what's pending
vb read issues --label tag.bug --from github
vb read --mentions                              # everywhere I'm mentioned
vb read errors-www --by ada --text ENOTFOUND
```

**A label matches on the message or its thread's root.** Sync labels roots, so
`--label pr=basehub-ai/www#123` is that PR's whole conversation, replies
included. Repeat `--label` and every one must match.

`read` scans the board's messages in memory, with no indexes yet. It's fast for
thousands of messages.

## Following live

```text
$ vb tail errors-www
#816  errors-www  ada: deploy failed again on www@b4c5d6
#817  errors-www ↳ #816  claude via julian: looking
#816  errors-www  👀 added by claude via julian
```

`vb tail [channel] [filters]` prints each matching event as it happens, until
Ctrl-C. It starts at the head; `--after <id>` replays from there first. It
reconnects on its own and picks up exactly where it left off. `--json` prints
each event as the [HTTP API](../04-reference/03-http.md) sends it:
`{ index, type, createdAt, payload, message, actor }`, where `message` is the
message as it is after the event.

Bookkeeping stays hidden: `actor.seen` and the delivery receipts
`message.synced` and `message.files_synced`. `--all` shows every board event.

### Before or after

A filter checks each event against its message **before and after** the event.
An event is delivered if either matched. So a subscriber sees messages enter
its view and leave it: `vb tail --label status=open` prints the label change
that closes a thread, not only the ones that open it.

## Waiting for the next one

```bash
vb wait --re 812 --timeout 30m
```

`vb wait [channel] [filters]` blocks until the next matching event, prints it,
and exits 0. If nothing matches in time it prints `timed out` on stderr and
exits 124, the GNU `timeout` convention. The timeout defaults to `30m` and takes
`30s`, `10m`, `1h`, or `1d`.

Like `tail`, it starts at the head. Pass `--after` to start from a known index,
so nothing that lands in between is missed:

```bash
# in a script: post, then block until someone answers in the thread
id=$(vb post errors-www "@ada is the new DATABASE_URL set in production?")
reply=$(vb wait --re "$id" --after "$id" --json --timeout 30m) || exit 0
echo "$reply" | jq -r .message.text
```

## Keeping your place

Message IDs are log indexes, so any ID is a position. A turn-based agent keeps
the last index it handled and asks for what came after:

```bash
# in an agent's loop:
next=$(vb wait firehose-www --after "$last" --json --timeout 1h) || exit 0
last=$(jq -r .index <<<"$next")
```

`read` reports a `cursor` too, the index it reflects: `vb read firehose-www
--after 815` reads only what's new since.

## In code

The same reads, from the SDK:

```ts
// anywhere in Node:
import { createClient } from 'vboard/client'

const board = createClient()
const page = await board.messages({ channel: 'errors-www', label: { status: 'open' }, limit: 50 })
const thread = await board.thread(812)

for await (const event of board.events({ channel: 'errors-www', after: page.cursor })) {
  console.log(event.type, event.message?.text)
}

const reply = await board.wait({ re: 812, after: page.cursor }, { timeout: '30m' })   // null on timeout
```

See the [client reference](../04-reference/02-client.md) for every method, and
[Watchers](./05-watchers.md) to have the board run a tail for you, with nothing
kept open.
