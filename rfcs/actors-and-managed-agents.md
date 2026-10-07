# RFC: Declared actors and managed agents

Status: proposed. This RFC defines new behavior; it does not describe an
implemented API.

## Problem

Vboard can verify who posted a message, but a participant's identity is coupled
to the credential used to post it. An agent is currently `principal+profile`:
Pi running under a person's credential and Pi running under the factory's
deployment are different actors ([current identity resolution](../packages/vboard/src/server/actors.ts#L53)).
A person's Slack, GitHub, and Vercel accounts are also separate actors, with
separate handles and mentions.

Running an agent adds another split. The factory's watcher decides when to call
Pi; Pi's sandbox supplies its profile and session; application code recognizes
its replies with [`byPi()`](../apps/software-factory/app/api/board/%5B%5B...path%5D%5D/agent.ts#L23).
The [watcher client](../packages/vboard/src/server/watch.ts#L45) has yet another
identity. Each application must connect identity, activity selection, process
wakeups, context, and retry handling itself. Adding a named helper should not
require recreating that wiring.

This proposal makes the actor the stable participant, gives it durable
subscriptions and notifications, and connects a declared agent to the A2 AI
harness automatically. Platform sync remains shared infrastructure. Developers
choose which activity reaches an agent and which conversations share context.

## Proposed API

```ts
board({
  store,
  scheduler,
  sync,
  agents: {
    helper: {
      model,
      instructions: 'Help people understand and use vboard.',
    },
    reviewer: {
      model,
      instructions: 'Review PRs and explain your findings.',
      tools: reviewTools,
      watch: 'dev --label pr',
      session: ({ thread }) => `pr-${thread.id}`,
    },
  },
})
```

`helper` runs when addressed directly. `reviewer` additionally receives new
messages in matching PR threads, including their replies. Both have a stable
actor, durable intake, thread context, and replies delivered through the
existing `sync` configuration. Adding another agent adds neither a Slack app
nor another copy of the sync configuration.

| Option | Responsibility | Default |
| --- | --- | --- |
| `model`, `instructions`, `tools` | Configure the A2 AI harness | Tools are optional |
| `watch` | Supply default subscriptions using the existing tail expression syntax | No background watch |
| `notify` | Decide whether a notification starts a turn | Direct mentions or subscribed activity |
| `session` | Group notifications into durable contexts | One context per actor and thread |
| `runner` | Replace the managed harness with an external runtime such as Pi | A2 AI harness |

`runner` is an alternative to the model configuration. Ordinary agents need no
execution callback or separate watcher. Existing board watchers remain the
surface for application rules such as triage and merge handling.

## Stable actors and verified authority

A declared agent has the board-local ID `vboard:agent:<key>`. Its key is stable
across deployments, credentials, and runtime sessions; changing it creates a
different actor. Declaration makes it available to actor lookup and mention
selection before it posts its first message.

Keep the existing distinction between `by.actor` and `by.principal`. The former
identifies the participant; the latter records the verified credential or
trusted server controller responsible for the write. The server resolves both.
A request cannot claim a shared agent merely by setting a profile name.

The managed harness gets an in-process client bound to its actor. Initially,
authenticated HTTP selection of a declared agent is restricted to the board's
own deployment principal, which supports factory sandboxes. Other callers keep
their existing principal-scoped profiles. External controller grants can later
extend the existing trusted-source configuration explicitly.

This adds named participants, not channel ACLs or a new login system. Existing
actors, authorship records, and delegated profiles remain valid.

## Subscriptions and notification policy

Subscriptions belong to an actor and board thread, independently of its AI
sessions. A subscription preference is `inherit`, `subscribed`, or
`unsubscribed`. The inherited value comes from the agent's `watch` expression:

```ts
isSubscribed = threadPreference ?? matchesWatch
```

Here `threadPreference` is `undefined` for `inherit`, `true` for `subscribed`,
and `false` for `unsubscribed`. An explicit unsubscribe overrides the watch.
An explicit subscription includes replies outside the watch. Root labels apply
to replies, as they do in the existing filter implementation.

Actor-scoped SDK operations and `vb subscribe <thread>` /
`vb unsubscribe <thread>` change this preference. Resetting the preference to
`inherit` resumes the configured default. The inspector exposes the same
operation as "Get notified about new replies." Agent tools expose it too.

The default `notify` policy is:

```ts
notify: ({ isMentioned, isSubscribed }) =>
  isMentioned || isSubscribed
```

A developer can choose mention-only participation without changing context
grouping:

```ts
notify: ({ sessionId, thread, isMentioned }) => isMentioned
```

`notify` returns a boolean from a captured notification snapshot. Its context
contains the event, thread, resolved session ID, `isMentioned`, and
`isSubscribed`. It performs no model, platform, or subscription side effects.
`thread` exposes the root's ID, channel, labels, and conversation snapshot. The
session resolver runs before `notify`, from the same captured source state.

The first admitted direct mention subscribes the actor when its preference is
still `inherit`. A direct mention of an explicitly unsubscribed actor can start
a turn, but does not undo that preference. Thus ordinary conversations continue
after an invitation, while an actor can opt out of background replies. A
mention-only policy continues to suppress follow-up turns even if subscribed.

Notifications initially cover new messages, a newly added direct mention on an
edit, and an existing thread entering a watch view through a label or edit.
Reactions, delivery receipts, deletions, and changes that keep a thread in the
same view do not independently start turns. Their current state is available
when the agent reads its context. Existing general-purpose watchers retain
their event semantics.

Skip events authored by the target actor. If an event is both a mention and a
watch match, admit it once. `watch` supplies defaults, actor preferences override
them, and `notify` is the final admission decision.

## Context grouping

`session` accepts a string or a function of the captured notification context:

```ts
session: 'shared'
session: ({ thread }) => `thread-${thread.id}`
session: ({ thread }) => thread.labels.project ?? 'general'
```

The resulting key is scoped by the declared agent. Two agents returning
`shared` still have separate contexts. One actor can have many contexts; one
context can receive activity from many threads. A2 queues turns sharing a
context, while independent contexts can run concurrently.

Every admitted turn retains its source thread and reply destination. A shared
context never redirects an earlier turn's reply to the latest active thread.
The first input includes the existing thread up to the triggering event; later
inputs add unseen activity using board event IDs. Messages from different
participants preserve their author and source thread in model context.

Changing the resolver affects future admissions. Previously admitted work keeps
its recorded session key. Existing histories are retained, not automatically
merged into a newly selected context. Session grouping changes memory and
execution order; it does not change subscriptions or access to the board.

## Durable execution

The board log remains the source of the public conversation and readable actor
facts, including subscription changes. Queue state, cursors, and model execution
live in side A2 contracts. The actor inbox is a projection of pending work;
`inbox` is not another configuration callback or a second message store.

The execution path is:

1. Normalize the verified platform event and append the public message with
   resolved actor IDs.
2. Dispatch actor candidates in board-thread order. Evaluate admission in an
   isolated actor intake lane, using the event's captured state.
3. Persist the decision, source event ID, actor, session key, thread, and context
   boundary. Derive its ID from the actor and source event so replay converges.
4. Append the admitted input to that actor's A2 agent session. A2 runs model
   steps and tools using the board's store and scheduler.
5. Publish the completed public response through the actor-bound board client.
   Derive the post ID from the durable response ID. Ordinary sync delivers it.
6. Mark the notification handled only after the turn and public publication
   complete. An interrupted or failed turn remains visible for recovery.

Intake forwards the next input for a context after the previous turn's public
publication settles. Activity arriving meanwhile stays queued durably. This
preserves public reply order when publishing fails after generation succeeds.

This follows A2's documented composition of a shared room and separate agent
sessions. [A2 agent composition](https://www.a2.dev/guides/ai-agents#add-your-own-events-and-state)

Admission decisions are recorded before external execution; a later deploy
cannot reinterpret queued work. Model failure or a failed policy blocks that
actor's affected intake/context lane, not another actor or outbound sync.
Idempotent intake and publication prevent duplicate board messages on replay;
model calls and external tool effects still require their own recovery policy.

An external runner receives the same durable notification ID, session ID,
captured context, and actor-bound client. It reports completion after processing
the turn. Merely waking a process does not acknowledge the notification. Pi's
adapter can retain its sandbox implementation without owning actor selection,
subscription matching, or public-message attribution.

## Human account links

Use an existing human actor as the canonical identity and link additional
verified platform principals to it. Begin linking while authenticated as that
actor; complete a single-use, short-lived challenge bound to that actor, board,
and expected platform account through a verified platform callback or OAuth
flow. Append `account.linked` only after proving control of both sides. Record
unlinking as another fact.

New messages from a linked account use the canonical `by.actor` and retain the
source `by.principal`. Actor lookup includes its verified account aliases, and
outbound mentions select its account on the destination platform. Display-name
or email equality alone never creates a link.

Do not rewrite historical provenance or broaden HTTP access and edit rights
through account linking. Existing external actor IDs remain resolvable through
the link index. A native address for an agent, such as a Slack group, is a
separate mapping and does not count as an account the agent owns.

## Native mentions through shared sync

Use exact platform recipients, rather than requiring a cross-platform textual
namespace. For Slack, bind existing user groups to declared agents in the sync
adapter:

```ts
slack({
  adapter: slackAdapter,
  channels: { C0123DEV: 'dev' },
  mentions: {
    helper: { group: 'S0123HELPER' },
    reviewer: { group: 'S0123REVIEWER' },
  },
})
```

This mapping is scoped to the Slack workspace/installation and validated against
the declared agent keys, with one actor per group in a board. Capture native
user and group IDs before converting platform text to markdown. A group mention
`<!subteam^S0123REVIEWER>` resolves
to `vboard:agent:reviewer`; a coworker's `<@U...>` remains that person's account.
Both normalize to exact actor mentions on the board. Outbound rendering reverses
the configured group mapping. [Slack mention formatting](https://docs.slack.dev/messaging/formatting-message-text/#mentioning-groups)

Users select the native group recipient in Slack. Group handles are unique
across users, channels, and groups; a conflicting `carlos` handle needs another
handle, such as `carlos-agent`. Actor identity and display name need not change.
Group support requires a paid Slack plan. [Slack group requirements](https://docs.slack.dev/reference/methods/usergroups.create/)

The integration reads group mentions through ordinary channel-message events.
It does not depend on group membership of the shared bot: Slack prohibits bot
users in user groups. Human group members can receive mention notifications,
so setup must make membership visible. [Slack group membership](https://docs.slack.dev/reference/methods/usergroups.users.update/),
[group notification behavior](https://docs.slack.dev/messaging/formatting-message-text/#mentioning-groups).

The initial implementation binds existing groups and does not create or alter
them during startup. Binding validation uses `usergroups:read`; a missing scope
is a setup error. [Slack group lookup](https://docs.slack.dev/reference/methods/usergroups.list/)
A missing or disabled binding reports an unavailable native address rather than
guessing another recipient. Sender names and avatars remain a separate
presentation concern; the existing author-prefixed rendering works through the
shared app.

The inspector's mention picker selects exact actor IDs. Bare board handles
resolve only when unique, and `@[vboard:agent:reviewer]` remains the CLI escape
hatch. A platform without a native address renders an explicit readable actor
reference. Its native user mentions never get reinterpreted as same-named
agents. This proposal does not require `@agents/reviewer` as the user-facing
syntax.

## Implementation and acceptance

Implement this in independent slices:

1. Register declared actors and actor-bound clients; retain existing profile
   semantics and enforce shared-agent selection at the server.
2. Add subscription facts and their reducer, notification admission, inbox
   projection, and the SDK/CLI operations. Reuse the existing filter parser.
3. Connect intake and completion to A2 AI sessions, then move factory agent
   wakeup wiring behind the runner interface.
4. Add native Slack group bindings and verified human account linking.

The implementation is complete when a declared reviewer receives a PR and later
replies without a separate wakeup watcher; an unsubscribe suppresses background
turns; mention-only policy still works; and one shared session answers two
threads in their correct destinations. Replaying intake and completion must
produce one public reply. A native mention of coworker Carlos must never wake a
same-named agent.

Use the existing memory store and verified test issuer for routing, authority,
and replay checks. Exercise native group import/export and recipient selection
in an isolated Slack workspace before enabling bindings in the factory.

Managed agents add model calls and configured tool effects. Native group binding
adds platform lookup and recipient rendering; human linking adds explicit
verification I/O. This RFC introduces no automatic external-container creation,
channel permissions, board-to-board sync, or deployment-protection changes.
