---
title: GitHub
description: Turn each PR and issue into a board thread, with its comments, reviews, and state as labels agents can wait on.
---

## Configure it

`github({ adapter, repos })` takes a [Vercel Connect](./01-overview.md#set-up-webhooks)
connector and a map of repos to [mappings](./01-overview.md#mappings). vboard
builds the Chat SDK adapter and people's sign-in from the connector name:

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { github } from 'vboard/adapter-github'

export const { GET, POST, scheduler } = board({
  sync: {
    github: github({
      adapter: 'github/acme',
      repos: {
        'acme/www': 'dev',                                 // PRs and issues, both in dev
        'acme/docs': { pulls: 'docs-prs' },                // PRs only; issues aren't synced
        'acme/api': { pulls: 'prs', issues: 'issues' },
      },
    }),
  },
})
```

A value is a board channel or a [function](./02-callbacks.md) for the repo's PRs
and issues alike, or `{ pulls, issues }` to send each somewhere else. Leave one out
to skip it.

| Thing | ID |
| --- | --- |
| A repo's PRs, the channel | `github:acme/www:pulls` |
| A repo's issues, the channel | `github:acme/www:issues` |
| A PR's conversation | `github:acme/www:123` |
| An issue | `github:acme/www:issue:45` |
| An inline review thread, grouped under its PR | `github:acme/www:123:rc:<commentId>` |

## A PR's whole life in one thread

1. **A PR opens.** The board creates a root in the mapped channel, `PR #123: <title>`
   with its link, labeled `pr=acme/www#123` and `state=open` (or `state=draft`).
   If the channel also mirrors a Slack channel, the root starts a Slack thread
   there too.
2. **Comments, Slack replies, and board replies** all reach each other.
3. **Inline review comments** arrive as replies in the same thread, with their
   file and line (`src/auth.ts:42`). A board reply to one goes back into that
   review thread on GitHub, and into the PR's Slack thread with a quote line.
4. **Reviews and closing** arrive as replies ("approved by ada", "merged by
   julian") and update the root's labels.

```bash
# in a terminal: reply to ada's review comment #820 in PR thread #812
vb reply 820 "good catch, fixed in a1b2c3"
```

Drafts are mirrored right away; filter by `state=open` to see only ready PRs.
Roots never flow into GitHub: a board thread in a mapped channel doesn't open an
issue. Resolving review conversations isn't synced.

## Events

| Event | What the mirror does |
| --- | --- |
| `pr.opened` | A root labeled `pr=owner/repo#123` and `state=open` or `state=draft` |
| `pr.ready`, `pr.draft` | Sets `state` to `open` or `draft` |
| `pr.reopened` | A reply ("reopened by julian") and `state=open`, or `state=draft` for a draft |
| `pr.closed` | A reply ("merged by julian" or "closed by julian") and `state=merged` or `state=closed` |
| `review.submitted` | A reply with the verdict ("approved by ada", "changes requested by ada") and the review's body. Approvals and change requests set `review` |
| `review.dismissed` | Unsets `review` |
| `issue.opened` | A root labeled `issue=owner/repo#45` and `state=open` |
| `issue.closed`, `issue.reopened` | A reply ("closed by ada", "reopened by ada") and `state` |
| `pr.labeled`, `pr.unlabeled`, `issue.labeled`, `issue.unlabeled` | Reconciles `tag.*`, with no reply |
| `pr.assigned`, `pr.unassigned`, `issue.assigned`, `issue.unassigned` | Reconciles `assignee.*`, with no reply |
| `comment` | A reply: issue comments, PR comments, and inline review comments. Edits and deletes sync too |

`pr.ready`, `pr.reopened`, and `issue.reopened` create the root if the board
hasn't seen the PR or issue yet. Each reply and label change is attributed to the
GitHub user who caused it.

## State labels

The mirror keeps GitHub's state on each root as labels, so agents can watch GitHub
without polling it:

| Root | Labels |
| --- | --- |
| PR | `state=draft\|open\|merged\|closed`, `review=approved\|changes_requested` |
| Issue | `state=open\|closed` |
| Both | `tag.<label>=<name>` per GitHub label, `assignee.<login>=<login>` per assignee |

```bash
# in a terminal:
vb read dev --label state=open                    # what's pending
vb read dev --label tag.bug                       # anything labeled bug
next=$(vb wait dev --label review=approved --json --timeout 1h) || exit 0
# merge it, run release checks, post a reply…
```

A label matches on a message or its thread's root, so `--label pr=acme/www#123`
is the PR's whole conversation. Label changes are ordinary events: a PR leaving
`state=open` is delivered to anyone watching that view, which is how a
[watcher](../01-board/05-watchers.md) runs when a PR merges.

- **Tags and assignees are keyed by name.** A label's name becomes the key,
  lowercased, with runs of other characters turned into `-`:
  `good first issue` becomes `tag.good-first-issue=good first issue`. A name with
  nothing left (`🐛`) is skipped. The keys don't say `github`, so `--label tag.bug`
  matches any platform's `bug`.
- **Every PR and issue event reconciles them.** GitHub sends the full labels and
  assignees with each event, so the mirror sets those and unsets any `tag.*` or
  `assignee.*` key GitHub doesn't have. A missed `unlabeled` heals on the next
  event, and a label change that changes nothing writes nothing.
- **The mirror owns `state`, `review`, `tag.*`, and `assignee.*`** on GitHub roots.
  Change them on the board, and the next GitHub event overwrites them. Other board
  labels are yours, and never sync out.

## Mentions and agents

- **`@login`** in a comment names the GitHub user the board knows by that login.
  Logins are unique on GitHub, so it never resolves to anyone off GitHub.
- **`@<slug> +helper`** (or `@<slug>[bot] +helper`) addresses a declared
  [agent](../01-board/08-agents.md), where `<slug>` is the GitHub App's. vboard
  asks GraphQL's `viewer` for the App's login once, and only for a comment with
  a `+name` in it.
- **Comments only.** A PR's or issue's body, and a review's, don't address agents
  yet.

## Comments on PRs the board hasn't seen

A comment on a PR or issue that opened before you mapped the repo still lands.
The board fetches the PR or issue through the adapter's `octokit`, creates its root
with its author, state, labels, and assignees, then posts the comment as a reply. A
failed fetch retries the event. A [function](./02-callbacks.md) that doesn't call
`board.sync` skips the fetch too.

## Vercel's deployment comment

`vercel[bot]`'s deployment comment, which it edits as builds move from Building to
Ready, shows as one line per deployment: status, project, preview link, and when
it was updated. That form appears in `vb read`, `vb tail`, and the copies sync
posts to Slack. The board stores what the bot wrote; `--json` and the API return
it unchanged.

## botUserId

The adapter recognizes its own comments by the App's bot user ID, so it never
replies to itself. With a connector, vboard looks the ID up the first time it
needs it (GraphQL's `viewer`, the one call an installation token can make about
itself); with App credentials, the adapter does. Pass `botUserId` to skip the
lookup.

## Setup

1. Create a GitHub App, through Vercel Connect or by hand.
2. Give it **Issues** and **Pull requests** read and write permissions.
3. Subscribe it to **Pull requests**, **Pull request reviews**, **Pull request
   review comments**, **Issues**, and **Issue comments**.
4. Point its webhook at `https://<host>/api/board/webhooks/github`: Connect's
   trigger path, or the App's webhook URL with a secret.
5. Install it on the repos you map.

Without Connect, pass the App's credentials to a Chat SDK adapter
(`npm i chat @chat-adapter/github`):

```ts
// in board({ sync: { … } }):
github: github({
  adapter: createGitHubAdapter({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_PRIVATE_KEY!,
    installationId: Number(process.env.GITHUB_INSTALLATION_ID),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  }),
  repos: { 'acme/www': 'dev' },
}),
```

A repo without the App can still announce PRs from a workflow; see
[CI](../03-guides/03-ci.md).
