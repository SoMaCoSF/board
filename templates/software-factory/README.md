# software factory

A board, an agent, and a sandbox that take your team's bugs, features, and questions to pull
requests. Issues and PRs from your GitHub repos, and threads from a Slack channel, come into the
board, and the agent hears every message. It answers questions, reproduces bugs, opens PRs with
fixes and features, reviews every PR, and stays quiet when nothing's for it.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvboard%2Ftree%2Fmain%2Ftemplates%2Fsoftware-factory&project-name=factory&repository-name=factory&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

Deploying makes your copy of this repo, a Vercel project, its Redis, and its Blob store. Then open
the deployment: its page is the launcher. Each step checks the deployment and says what to do:

1. **Vercel.** Vercel Authentication and a Protection Bypass for Automation, Upstash for Redis (the
   board's log), a private Blob store (its files), and AI Gateway (the agent's model).
2. **GitHub.** A Vercel Connect connector whose app is on the repos the factory works on, this one
   included, so the agent can change the factory itself. This repo's PRs and issues come into
   `dev/factory`; map each of yours to a channel in `REPOS` (`connectors.ts`). A fork's PRs stay
   off the board, and each thread's GitHub token covers only its own repo.
3. **Slack**, optionally. A channel that mirrors the board.
4. **Try it.** Open an issue, or say hi on the page, and the agent replies.

## How it's built

| Path | What it is |
| --- | --- |
| `app/page.tsx`, `lib/setup.ts` | The launcher, and its checks |
| `app/api/board/[[...path]]/route.ts` | The board: its store, sync, and watchers, all configured here |
| `agent/` | The agent, an [eve](https://www.npmjs.com/package/eve) agent mounted at `/eve/v1` |
| `agent/lib/wake.ts` | What the board sees of the agent: `wakeAgent`, which the board's watcher runs on every message |
| `agent/lib/instructions.ts` | What the agent does with what it hears: edit it to change how it works |
| `agent/schedules/update-template.ts` | A daily check for a new release of this template |

The board only reaches the agent through the watchers it exports, so another agent swaps in by
exporting watchers of its own.

## Locally

```bash
pnpm install
vercel link && vercel env pull   # the project's OIDC token, for AI Gateway and Connect
pnpm dev
```

Locally the board keeps its log in `.a2/dev.db` and its files in `.a2/attachments`. Read it with
`BOARD_URL=http://localhost:3000/api/board vb inspect`.

## Updates

This repo is a copy, not a fork: it doesn't follow the template on its own. Once a day,
`agent/schedules/update-template.ts` compares `package.json`'s `version`, the template release
this factory is on, with the latest. When there's a newer one, it posts a task on the board, and the
agent merges the new release into this repo with the `update-template` skill, keeping your changes.
It opens a PR; nothing merges without a person.
