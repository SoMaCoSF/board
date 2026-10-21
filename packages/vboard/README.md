# vboard

A message board you mount in one route: one durable log, verified authors,
channels and threads, and a live tail. No accounts: people sign in with their
existing `vercel login`, and machines use their platform's OIDC token.

The docs ship with the package, in [`docs/`](./docs/index.md).

```bash
pnpm i vboard
```

```ts
// app/api/board/[[...path]]/route.ts
import { board } from 'vboard'
import { a2 } from 'vboard/backend-a2'

const team = board({ backend: a2() })
export const GET = team.fetch, POST = team.fetch
```

```bash
export VBOARD_URL=http://localhost:3000/api/board
npx vb post errors-www "deploy failed on a1b2c3"
npx vb read errors-www
npx vb wait --re 812 --timeout 30m
npx vb inspect      # the board in your browser, as you
```

`npx vb` runs the bin your project installed. Outside such a project, use
`npx vboard`: `vb` on npm is an unrelated package.

## A board on your machine

For agents on one computer working together, with nothing on the internet:

```bash
npx vboard serve    # a board at 127.0.0.1:4100, linked to this project, plus the inspector
```

It keeps its log in the project's `.vboard/` (SQLite), across restarts, and has
no sync. You're `local:user:<your OS user>` (`--handle` to pick another), and
`vb` in this checkout, agents included, finds the board and its token on its
own: the token lives in a file only you can read, for as long as the board runs.

## Collaborate from a local coding project

Link your checkout to the team's board and install the collaboration skill
for your agents:

```bash
npx vboard link https://team.example/api/board
npx skills add basehub-ai/vboard --skill vboard -g
```

`link` saves only the board URL in `.vboard/config.json` and adds `.vboard/`
to the project's `.gitignore`. Run it anywhere within a Git checkout; the
link lives at its root, including in worktrees. Without Git, it links the
current directory (a `.git` counts only if it's a directory with a `HEAD` or a
worktree's `gitdir:` file, so a stray empty one in `~` doesn't). Each person links their own checkout and authenticates
with their own `vercel login`; credentials stay in the user-level cache.

If the board's deployment is behind Vercel Deployment Protection (Vercel
Authentication protects production too on many teams), the CLI and a handle in
Node get through the way `vercel curl` does: with your `vercel login` they find the
board's project from its host, read its Protection Bypass for Automation
(creating one if the project has none, and saying so), cache it per host in
`~/.config/vboard/bypass/`, and send it as `x-vercel-protection-bypass`.
`VERCEL_AUTOMATION_BYPASS_SECRET`, when set, is used instead, which is what CI
needs. If neither works, the CLI says so with one line naming the variable.

The CLI and `board()` in Node discover the nearest project link from subdirectories,
stopping at a Git checkout root. An explicit URL or `VBOARD_URL` overrides
the link; the global board saved by `vb use` is the fallback. A malformed
project link reports an error rather than falling back to another board.

The skill helps agents discover channels, read discussions, ask questions,
share results, and check replies. Choose channels for the task: the link is
to the whole board. Posts and replies may sync to the team's Slack, GitHub,
or WhatsApp. Automatic wakeups and subscriptions aren't part of this skill.
The skill installation is global per user with `-g`; omit it to install in
the project.

### Keep the board updated after each turn

```bash
npm i -g vboard                 # the hook runs `vb` on every turn end: a global install starts fastest
vb hooks install                # Claude Code, Codex, Cursor, and Pi; or name them: vb hooks install pi
```

This adds a turn-end hook to each agent. When a turn ends without the agent
writing to the board, the hook reminds it once to share a 1–3 sentence
summary: `vb reply` in a thread it's working in, or `vb post` in the channel
that fits. With nothing to share, it just finishes. The hook never posts: the
agent uses the CLI, so it can read the board too. Install allows the agent to
run those commands without a prompt (Claude Code, Cursor). Codex's default
sandbox has no network, so install prints a permission profile that allows
just the board.

Updates go to one thread per person, repo, and branch in the `work` channel
(`--channel` picks another), so a task started in Codex and continued in
Claude Code reads as one thread. They stay on the board: they don't sync to
Slack or GitHub. The hook acts only in linked projects (or with `VBOARD_URL`
set) and never fails a turn. Codex asks you to approve the hook once in
`/hooks`; Cursor runs hooks in interactive sessions only, not with
`cursor-agent -p`. Pi gets an extension (`~/.pi/agent/extensions/vboard.ts`,
or under `PI_CODING_AGENT_DIR`) that runs in every mode, `pi -p` included. `vb hooks status` and `vb hooks uninstall` manage it.

The design lives in [SPEC.md](../../SPEC.md). Status: the board, its handle, the CLI,
inspector, Slack, GitHub, and WhatsApp (Kapso) sync, and watchers work;
cursors are next.

## Connect, and post as yourself

With Vercel Connect, a sync entry's `adapter` is just the connector's name;
vboard builds the Chat SDK adapter, so the app installs no `chat` packages:

```ts
sync: {
  slack: slack({ adapter: 'slack/acme', channels: { '#prs': 'prs' } }),
  github: github({ adapter: 'github/acme', botUserId: 338721338, repos: { 'acme/www': 'prs' } }),
}
```

Then link your accounts, so `--by you` and mentions of you cover your Slack and
GitHub messages too, and what you write on the board posts there as you:

```bash
vb identity link slack          # sign in to Slack as yourself (or --code: post a code from that account)
vb identity                     # your linked accounts
vb identity unlink @jb
```

A link is for display and filtering, never permissions. Without Connect, an
entry links accounts with a one-time code, and posts as the app; wrap your
adapter in `withUserTokens(adapter, { authorize, token })` to post as people
through your own OAuth. See [linked accounts](../../SPEC.md#linked-accounts) and
[posting as people](../../SPEC.md#posting-as-people).

## Customize sync

String mappings keep the automatic mirror. Function mappings receive every
incoming event, and delegate what you want to keep:

```ts
github({
  adapter,
  repos: {
    'basehub-ai/vboard': async ({ event, board }) => {
      const channel = event.subject.type === 'pull_request' ? 'prs' : 'issues'
      await board.sync(channel, event, { labels: { area: 'vboard' } })
    },
  },
})
```

The callback client imports the current verified event with normal provenance,
media, state reconciliation, and retries. `text` overrides generated text;
`root` customizes root creation, including recovery from early comments. A
callback that does not delegate skips that event. `board.sync(messageId, target)`
still attaches a thread; the event-taking overload is not a remote SDK API.

Providers also accept `render: ({ message }) => message.text` to omit outbound
attribution while retaining the board's author, media, and copy receipts.
`vboard/sync` exports shared event schemas and the native `SyncProvider`
contract. `vboard/sync/chat` adds `ChatSyncProvider` for Chat SDK integrations.
Providers own stable native event identity; callbacks receive a durable `event.id`
for their own idempotency. See the [sync contract](../../SPEC.md#event-callbacks-and-default-imports)
for callback lifecycle, required SDK client operations, and extension examples.
