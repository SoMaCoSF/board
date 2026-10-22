---
title: Custom providers
description: Sync a platform vboard doesn't ship, natively or through any Chat SDK adapter.
---

## Two ways in

| Import | Base class | Use it when |
| --- | --- | --- |
| `vboard/sync` | `SyncProvider` | You talk to the platform yourself: its webhooks, its API. Importing it doesn't load Chat SDK. |
| `vboard/sync/chat` | `ChatSyncProvider` | A Chat SDK adapter already speaks the platform. Slack, GitHub, and WhatsApp are built this way. |

Either way, a provider translates between the platform and the board, and the
board does the rest: it validates and stores every incoming event before
answering, orders imports per external thread and deliveries per board thread,
retries, skips echoes, records copy and file receipts, and runs the default
imports and your [callbacks](./02-callbacks.md). Durable state lives in A2;
a provider keeps only SDK caches and credentials.

## A native provider

```ts lib/desk.ts
import { z } from 'zod'
import {
  SyncProvider,
  envelope,
  eventSchema,
  type EventMapping,
  type ProviderPost,
  type Receive,
  type ResolvedTarget,
  type SyncContext,
} from 'vboard/sync'

export const DeskEvent = eventSchema('desk', 'message')
export type DeskEvent = z.infer<typeof DeskEvent>

type Delivery = {
  delivery: string
  inbox: string
  ticket: string
  message: string
  text: string
  user: { id: string; name: string }
}

export class DeskProvider extends SyncProvider<DeskEvent> {
  private readonly secret: string

  constructor(options: { secret: string; inboxes: Record<string, EventMapping<DeskEvent>> }) {
    super({ platform: 'desk', canStartThreads: true })
    this.secret = options.secret
    for (const [inbox, mapping] of Object.entries(options.inboxes)) this.map(inbox, mapping)
  }

  override async receive(key: string, request: Request, emit: Receive): Promise<Response> {
    // here's where you'd verify the platform's signature, before emitting anything:
    if (request.headers.get('x-desk-secret') !== this.secret) return new Response('unauthorized', { status: 401 })
    const body = (await request.json()) as Delivery
    await emit({
      dedupe: body.delivery,
      raw: body,
      event: {
        kind: 'message',
        channel: `${key}:${body.inbox}`,
        thread: `${key}:${body.inbox}:${body.ticket}`,
        subthread: null,
        message: body.message,
        text: body.text,
        isRoot: false,
        context: null,
        author: { id: `desk:user:${body.user.id}`, handle: body.user.name, name: body.user.name, avatar: null, isBot: false },
      },
    })
    return new Response('ok')
  }

  override async resolveChannel(key: string): Promise<string> {
    return key
  }

  override async resolveTarget(target: string): Promise<ResolvedTarget> {
    const [inbox, ticket] = target.split(':')
    return { target, channel: inbox!, kind: ticket ? 'thread' : 'channel' }
  }

  override async post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost) {
    // your platform's API, e.g. a new ticket for a channel target, a reply for a thread:
    // const sent = await desk.post(target, body.markdown)
    const sent = { ticket: 't_812', message: 'm_1' }
    return { thread: kind === 'channel' ? `${target}:${sent.ticket}` : target, message: sent.message }
  }

  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>): DeskEvent {
    return DeskEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
```

Then use it like any built-in entry. Its webhook is `/webhooks/desk`:

```ts
// in board():
sync: {
  desk: new DeskProvider({ secret: process.env.DESK_SECRET!, inboxes: { support: 'support' } }),
},
```

`this.map(key, mapping)` registers a mapping, so your provider takes the same
string, function, and `{ channel, run }` values as the built-in ones.

## The contract

**Required methods:**

| Method | Does |
| --- | --- |
| `receive(key, request, emit)` | Authenticates the request, then emits normalized `{ event, raw, dedupe }` records, and answers what the platform expects. |
| `resolveChannel(key)` | Turns a mapping key (`'#prs'`, `'support'`) into the platform's channel ID. |
| `resolveTarget(target)` | Turns a sync target into `{ target, channel, kind }`, where `kind` is `channel` or `thread`. |
| `post(target, kind, body)` | Posts `body` (`{ markdown, files?, as? }`) and returns `{ thread, message, files? }`. |
| `event(context)` | Builds the typed envelope your callbacks receive, usually `envelope(…)` parsed by an `eventSchema`. |

**IDs.** Incoming locations (`channel`, `thread`, `subthread`) carry the entry's key
as a prefix: `desk:support:t_812`. Targets handed to `post`, `resolveTarget`, and the
optional methods are native, without it: `support:t_812`. The board records each
target's `kind` from `resolveTarget`, so it never parses your ID syntax, and a
channel target on a provider whose `canStartThreads` is false is refused.

**Dedupe.** `dedupe` is the identity of one occurrence. A platform redelivering the
same event must produce the same value, so the retry does nothing; a later
identical action (a reaction added, removed, and added again) must produce a new
one. Use the platform's delivery or event ID.

**Intake.** The board validates each record and stores it before your `receive`
returns. Events for channels you don't map and threads that aren't synced are
dropped. If storing fails, the webhook answers 500 so the platform retries.

**Options** passed to `super()`:

| Option | Default | Means |
| --- | --- | --- |
| `platform` | (required) | The platform's name, shown by `vb sources` and in author labels like `ada (desk)`. |
| `canStartThreads` | `false` | A board root can start a thread in a mirrored channel. |
| `singleReaction` | `false` | One reaction per person per message, as on WhatsApp. |
| `uploadsFiles` | `false` | Files go to the platform with `uploadFiles`; otherwise each gets a line in the text. |
| `render` | the label and text | The outgoing body; see [render](./02-callbacks.md#render). |

## Optional methods

Each has a default that does nothing, or says the platform can't:

| Method | For |
| --- | --- |
| `edit(thread, message, body)`, `delete(thread, message)`, `react(thread, message, emoji, added)` | Changes to messages already delivered |
| `startTyping(thread, latest, status?)` | `vb typing` |
| `uploadFiles(thread, files)`, `deleteFiles(ids)`, `refusesFiles(error)` | Files out. `refusesFiles` tells a permanent refusal (notes instead) from a failure worth retrying |
| `fetchFile(file)` | Files in |
| `fetchRoot(thread)` | Recovering a root when a reply arrives in a thread the board hasn't seen |
| `fetchLink(link, poster)` | Reading a linked message the platform didn't describe, if `poster` could read it there |
| `read(target, { limit })` | `vb sources <key> read` |
| `mention(actor)` | A board mention in the platform's native form |
| `findByEmail(email)` | `@[ada@acme.com]` mentions |

`sync(context, channel, overrides)` applies the default import and `render(input)`
builds the outgoing body; override either in a subclass.

## Through Chat SDK

`ChatSyncProvider` bridges any Chat SDK adapter. It runs one Chat instance per
entry, verifies webhooks through the adapter, turns its messages, edits, deletes,
and reactions into records, and fetches files with the adapter's
`rehydrateAttachment`:

```ts lib/forum.ts
import { z } from 'zod'
import type { Adapter } from 'chat'
import { envelope, eventSchema, type EventMapping, type ResolvedTarget, type SyncContext } from 'vboard/sync'
import { ChatSyncProvider, type ChatInput } from 'vboard/sync/chat'

export const ForumEvent = eventSchema('forum', 'message')
export type ForumEvent = z.infer<typeof ForumEvent>

export class ForumProvider extends ChatSyncProvider<ForumEvent> {
  constructor(options: { adapter: Adapter; channels: Record<string, EventMapping<ForumEvent>> }) {
    super({
      platform: 'forum',
      adapter: options.adapter,
      canStartThreads: true,
      resolveChannel: async (key) => key,
      resolveTarget: async (target): Promise<ResolvedTarget> => {
        const at = target.indexOf(':')
        return { target, channel: at === -1 ? target : target.slice(0, at), kind: at === -1 ? 'channel' : 'thread' }
      },
    })
    for (const [channel, mapping] of Object.entries(options.channels)) this.map(channel, mapping)
  }

  // A reaction has no stable identity in general: use the platform's ID for this occurrence.
  override eventId(key: string, input: ChatInput): string {
    if (input.kind !== 'reaction') return super.eventId(key, input)
    return `reaction:${key}:${z.object({ id: z.string() }).parse(input.reaction.raw).id}`
  }

  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>): ForumEvent {
    return ForumEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
```

`eventId(key, input)` supplies `dedupe`. The default covers messages, edits, and
deletes; a provider that receives reactions must override it, since only the
platform knows one reaction occurrence from the next.

The constructor also takes hooks for what differs between platforms, among them:
`groupThread` (which board thread an external thread belongs to, like GitHub's
review threads), `channelOf`, `toChatId` and `fromChatId` (ID encodings),
`markdown` and `author` (reading a message), `context`, `fetchRoot`, `links`,
`read`, `uploadFiles`, `refusesFiles`, `startTyping`, and `intercept` and `missed`
(webhook events the adapter doesn't emit). The built-in providers in
`vboard/adapter-slack`, `vboard/adapter-github`, and `vboard/adapter-kapso` are
working examples of each.
