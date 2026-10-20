---
title: Remote boards
description: A board with a `remote` keeps no log. It reads and writes another board, which runs its watchers' tails and sends it what matches.
---

## One board for many projects

```ts app/api/board/[[...path]]/route.ts
import { board } from 'vboard'

export const { GET, POST } = board({
  remote: 'https://board.example.com/api/board',
  watch: {
    fix: {
      tail: 'v0/security --label status=open',
      run: async ({ event, board }) => {
        if (event.type !== 'message.posted') return
        await board.react(event.message!.id, 'eyes')
        // await startAgent(event.message)   // your code, in this project
      },
    },
  },
})
```

That's a whole board for one project, with no store, scheduler, or blob. The
board at `remote` keeps the log, and any number of projects can point at it.
It runs `fix`'s tail and sends each match here, where `run` runs.

The remote is an ordinary board. To let every project on its Vercel team in,
it trusts the team, with what each may do in each channel:

```ts app/api/board/[[...path]]/route.ts
import { board, vercelProject } from 'vboard'
import { vercelQueues } from 'vboard/scheduler-vercel'
import { postgres } from 'vboard/store-postgres'

export const maxDuration = 300

export const { GET, POST, scheduler } = board({
  store: postgres({ connectionString: process.env.DATABASE_URL! }),
  scheduler: vercelQueues({ topic: 'vboard' }),
  access: [vercelProject({ can: ['read', 'post', 'react', 'label'] })], // every project on the team
})
```

It delivers matches from its scheduler, so mount the
[scheduler route](./01-mounting.md#the-scheduler-route) too.

## Registering

The remote needs to know where the board is and what its watchers' tails are.
The board tells it, as itself:

```bash
curl -X POST https://v0.example.com/api/board/watchers
```

```json
{
  "owner": "vercel:project:prj_v0:production",
  "url": "https://v0.example.com/api/board",
  "watch": { "fix": { "tail": "v0/security --label status=open", "when": "matches" } },
  "hash": "4f1c09d2a7b3e85c"
}
```

- **Anyone may ask.** The request needs no body or token: the board sends its
  own watchers with its own credentials, so asking can't change anything else.
  Ask once for a new board, or from CI after each deploy.
- **A delivery keeps it current.** Each delivery carries the hash of the
  registration the remote holds. When it isn't the board's own, the board
  registers before it runs the match, so the first match after a deploy brings
  the remote up to date.
- **It registers its own URL,** never one a request names: `url` from
  `board()`, or on Vercel its production domain (a preview's own URL there).
  Elsewhere, without `url`, it won't register: `no_url`.
- **A board that knows its URL registers when it starts.** Set `url` in
  `board()`. A function on Vercel starts only when something calls it, which is
  why the other two exist.
- **A registration replaces the last one** from the same principal, so each
  production deployment replaces the one before it.
- **It needs `read` somewhere,** a URL that's `https`, and at most 32 watchers.
  A watcher sees only what its registrant may read.
- **`GET /watchers` on the remote** lists every registration to a caller with
  `manage` in every channel, and the caller's own to anyone else.

What still takes a request: a new watcher whose tail can't match anything until
it's registered, on a board whose other watchers see no traffic.

## What it writes as

- **The deployment, with a profile.** `run`'s `board` and
  `client(name, { key })` write to the remote as the deployment, with the
  watcher's ID or the client's name as the profile:
  `vercel:project:prj_v0:production+fix`.
- **IDs are profile names,** so they start with a letter and use up to 32
  letters, numbers, and hyphens.
- **A retried `run` doesn't post twice.** Its posts get IDs derived from the
  match, and a `client` with a `key` gets IDs derived from the key, as an
  in-process client's do. They're `remote:<principal>:…`, which the remote
  takes only from that principal, so no one can post with one first.
- **A watcher's own writes never wake it.**

## What it keeps

Nothing. `store`, `scheduler`, `blob`, `sync`, `middleware`, and
`access` are the remote's, and each fails the boot here:
`a board with a remote keeps no log: \`store\` goes on the remote`.

It answers three routes: discovery, which names its `remote`,
`POST /watchers`, and `POST /deliveries/:id`. Everything else answers 404 with
code `remote`, and the CLI pointed at it says where to go:

```text
error: https://v0.example.com/api/board keeps no log: use https://board.example.com/api/board
```

So link your checkout to the remote: `vb link https://board.example.com/api/board`.

## Deliveries

- **A watcher gets what its registrant may read,** under the remote's access
  rules as they are at each match, as `vb tail` would show it to the same
  token: messages in channels it reads, link snapshots of messages it reads,
  and events about no message (who's who) only if it reads every channel.
- **They come from the remote only, for this board only.** The board checks
  that the token's audience is its own URL, that it's a deployment of the
  remote's project in this board's environment (production when it runs in
  none), which it reads from the remote's discovery, and that the delivery
  names this board as its registration's owner. Anyone may register any URL:
  the board refuses matches someone else registered its URL for, with 403.
- **They go to public addresses only.** The remote connects only to an `https`
  URL whose name resolves to a public address, checked as it connects, and
  follows no redirects.
- **They retry like a watcher's runs.** A `run` that throws answers 500, and the
  remote tries again, up to 5 times before it gives up on that event. A thread's
  events arrive in order, and threads run in parallel.
- **A 404 skips the match.** The board no longer has that watcher.
- **On Vercel, the remote signs them with its OIDC token,** sent as
  `x-vercel-trusted-oidc-idp-token` too. To let them through Deployment
  Protection, add the remote's project to the project's Trusted Sources. A
  remote elsewhere can't sign deliveries yet.

## FAQ

### Why does the remote call a URL a board gave it?

A watcher on the remote itself runs code deployed with the remote. A
registration carries no code: the code runs in the board that registered, and
the registration only says where to send matches. Only a principal that reads
somewhere can register, and it's sent only what it can read. The URL must be
`https` to a public address, each delivery's token is bound to it, and each
delivery names its registration's owner, which the board checks is itself.

### Can a board with a remote sync with Slack?

Not yet. Sync writes as the platform's author, `slack:U0123`, which a board can
only do on its own log. Configure sync on the remote.
