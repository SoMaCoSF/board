---
title: Callbacks
description: Decide what each inbound platform event becomes, and how board messages look on each platform.
---

## A function per mapping

A string mapping imports every event into one channel. A function receives every
inbound event for its external channel, connected threads included, and decides:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'
import { github, GitHubPayload } from 'vboard/sync-github'

const backend = a2()

export const { GET, POST } = board({
  backend,
  sync: {
    github: github({
      adapter: 'github/acme',
      repos: {
        'acme/www': async ({ event, board }) => {
          const channel = event.subject.type === 'pull_request' ? 'prs' : 'issues'
          await board.sync(channel, event, {
            labels: { area: 'www' },
            root: ({ raw }) => {
              const payload = GitHubPayload.parse(raw)
              const item = payload.pull_request ?? payload.issue
              return { text: [item?.title, item?.body, item?.html_url].filter(Boolean).join('\n\n') }
            },
          })
        },
      },
    }),
  },
})
export const { scheduler } = backend
```

`board.sync(channel, event)` applies the default import: the same thing a string
mapping does, with the same provenance, files, links, state labels, and retries.
Call it once, await it, and the event lands on the board. Don't call it, and the
event is skipped; the thread stays connected, so later events still reach you.

For an event in a thread that's already synced, the channel is ignored: the event
lands in that thread. The channel only places new roots.

The function's other writes through `board` (a reply, a label, a reaction, an
edit or delete of the user's own message) are the platform user's, with the
same provenance as the import, and go through the
[middleware](../01-board/08-middleware.md) like it. Its reads, and anything
else it does, are sync's own. It works the same on any backend, a board on
`http()` included: there the writes land on the board it uses as imports.

## The event

Every event is an envelope, validated and frozen before your function sees it.
Fields every event has:

| Field | Value |
| --- | --- |
| `id` | The inbox event's ID. Stable across retries: use it as an idempotency key. |
| `platform`, `key` | `slack`, `github`, or `whatsapp`, and the entry's key. |
| `channel`, `thread` | External IDs with the key prefix: `slack:C0123ABC`, `slack:C0123ABC:1727000000.123456`. `thread` is what `sync` accepts as a target. |
| `subthread` | The precise sub-thread, when the adapter grouped it: a GitHub review thread. Otherwise `null`. |
| `kind` | `message`, `edited`, `deleted`, `reaction`, or `lifecycle`. |
| `type` | The narrower name: `message` (Slack, WhatsApp), `comment` (GitHub), `message.edited`, `message.deleted`, `reaction.added`, `reaction.removed`, or a lifecycle type like `pr.opened`. |
| `raw` | The platform's payload. |

Then, by kind:

- **`message`:** `message` (the platform's ID), `text` (markdown), `author`
  (`{ id, handle, name, avatar, isBot }`), `isRoot`, `context` (a GitHub review
  comment's `path:line`), and `files` and `links` when it has them.
- **`edited`:** `message`, `text`, `author`, `links`.
- **`deleted`:** `message`.
- **`reaction`:** `message`, `emoji`, `added`, `author`.
- **`lifecycle`:** `type`, `title`, `url`, `labels`, `reply`, and `author`. Only
  GitHub sends these: see the [events table](./04-github.md#events).

GitHub events also carry `subject: { type: 'pull_request' | 'issue', repo, number }`,
comments and reactions included. The types are exported: `SlackEvent` from
`vboard/sync-slack`, `GitHubEvent` and `GitHubPayload` from
`vboard/sync-github`, and `WhatsAppEvent` from `vboard/sync-kapso`.

## Permalinks

Every callback also gets `permalink()`, the platform's own link to the event's
message. It's fetched on the first call and reused after, so callbacks that never
ask don't cost an API request:

```ts
// in slack({ channels: { … } }): copy a report elsewhere, with a link back
'#reports': async ({ event, board, permalink }) => {
  if (event.kind === 'message' && event.isRoot)
    await board.post('triage', `${event.text}\n\n${await permalink()}`)
},
```

On Slack it calls `chat.getPermalink` with the provider's client, so the URL has
the workspace's own host (Enterprise Grid included) and a reply's `thread_ts`. It
only reads the URL: the thread isn't synced and no channel is joined. It returns
`null` for a lifecycle event or a deleted message, and on platforms without
links, and throws when Slack refuses, so the callback is retried.

## Overrides

The third argument changes the default import:

| Override | Effect |
| --- | --- |
| `text` | Replaces the imported message's text. For a lifecycle event that creates a root and a reply, it replaces the reply; for one that only creates a root, it's the root's final text. |
| `labels` | Merged into the thread root's labels. |
| `unset` | Label keys removed from the root, applied last. |
| `root` | A synchronous function that shapes a new root. It receives the default draft (`text`, `labels`, `author`, `raw`) and returns `{ text?, labels? }`. |
| `noSync` | Keeps the imported reply on the board, like `vb reply --no-sync`: no other platform the thread syncs to gets it, now or in a backfill. A root it creates still syncs. |

`root` runs whenever an import creates a root: a PR opening, or a comment on a PR
the board hasn't seen, which recovers the root first. Its labels merge into the
draft, then `labels` takes precedence, then `unset` removes keys. It can't change
the author or other provenance.

`noSync` keeps a GitHub PR's inline review threads out of its Slack thread, while
top-level comments and reviews still go through:

```ts
// in github({ repos: { … } }):
'acme/www': {
  channel: 'prs',
  run: async ({ event, board }) => {
    await board.sync('prs', event, { noSync: event.subthread !== null })
  },
},
```

Platform reconciliation still applies on later events: GitHub's next event
rewrites `state`, `review`, `tag.*`, and `assignee.*` unless you override them
again.

## The result

`board.sync` returns `{ root, message }`, the board IDs it touched:

- `root` is the thread's root.
- `message` is the imported message, the message an edit, delete, or reaction
  changed, or a lifecycle event's reply. A lifecycle event that only creates a root
  returns the root; one that only changes labels returns `null`.
- An event that can't apply (a reaction on a message the board never had) returns
  `null` where no board message exists.

Retried after it succeeded, it returns the same IDs.

## More than an import

`board` is the board's in-process client, the same one `createClient()` returns,
so a function can also reply, react, label, or attach:

```ts
// in slack({ channels: { … } }):
'#support': async ({ event, board }) => {
  const { root } = await board.sync('support', event)
  if (event.kind === 'message' && event.isRoot && root !== null)
    await board.label(root, { set: { status: 'new' } })
},
```

Its writes are authored by the platform actor who triggered the event, like
`slack:user:U0456`. It has no HTTP and no token.

## Reverse routing

A bare function chooses a channel when an event arrives, so the board can't know
which external channel a board root in `support` belongs to. Declare it:

```ts
// in slack({ channels: { … } }):
'#support': {
  channel: 'support',
  run: async ({ event, board }) => {
    await board.sync('support', event)
  },
},
```

Inbound events still go through `run`. A root posted in `support` on the board
now starts a thread in `#support`, and replies flow both ways through the
connection. Outgoing delivery never runs your function.

## Retries and idempotency

A function that throws is retried. Writes made through `board` take IDs derived
from the inbox event and the order of calls, so a retry that writes in the same
order doesn't post or schedule twice, and a default import that already
succeeded returns its existing message. Two rules follow:

- Writes made in parallel (`Promise.all`) need explicit `id`s.
- Your own side effects aren't covered. Key them on `event.id`:

```ts
// in a callback, your side effect:
// await createTicket(event, { idempotencyKey: event.id })
```

A function that keeps throwing dead-letters after 10 tries. That holds up only
its thread's lane in that channel's inbox; other threads and the board keep
flowing. Calling `board.sync` after the function returns, twice, or with an event
other than the one it received throws.

## Render

Every provider takes `render`, which decides the body of each board message it
posts. It receives immutable copies of the message, as clients see it (its IDs
are strings), and its author, the default label, and the resolved destination,
and returns markdown:

```ts
// in kapso({ … }): post the text alone, without the author label
render: ({ message }) => message.text,
```

The default is `**${label}**: ${message.text}`, where the label is the author's
name: `claude via julian` for an agent profile, `ada (slack)` for a message that
came from a platform. vboard still adds a line per attachment the platform
didn't take, and converts mentions to the platform's own form after your
function runs.

A renderer can read labels. When a label change changes what a delivered copy
renders to, vboard edits that copy, so a PR's root in Slack can show its state:

```ts
// in slack({ … }):
render: ({ message, label }) =>
  message.re === null && message.labels.state === 'merged'
    ? `:pr-merged: ${message.text}`
    : `**${label}**: ${message.text}`,
```

`mentionOf(actor)` returns how the platform mentions an actor (`<@U0456>` in
Slack), through any account their person linked, or null. The default label is
the author's name, so nobody gets pinged unless a renderer asks:

```ts
// in slack({ … }): a PR's root mentions its owner, or its author
render: ({ message, label, mentionOf }) => {
  const who = (message.labels.owner && mentionOf(message.labels.owner)) ?? mentionOf(message.by.actor)
  return message.re === null && message.labels.pr && who
    ? `${message.text} · ${who}`
    : `**${label}**: ${message.text}`
},
```

The default renderer reads no labels, so labels alone never edit a copy. Rendering
applies to roots, replies, backfills, and edits; changing it affects future
deliveries, not copies already sent. A subclass can override `render(input)`
instead; see [custom providers](./06-providers.md).
