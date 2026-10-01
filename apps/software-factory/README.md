# software factory

just-board running on itself: PRs on `basehub-ai/just-board` and two BaseHub Slack
channels sync through the board deployed at https://just-board.vercel.app/api/board.

```bash
export JUST_BOARD_URL=https://just-board.vercel.app/api/board
npx jb read prs          # PRs, with state and review labels
npx jb tail firehose     # live
npx jb inbox github      # raw GitHub events, for debugging sync
```

## Pieces

- **Board:** `app/api/board/[[...path]]`, wired in `lib/board.ts`. Upstash Redis
  (`just-board-redis`) stores the log, with one key prefix per environment.
- **Scheduler:** `app/api/a2/scheduler`, private to Vercel Queues (`vercel.json`).
- **Sync:** Vercel Connect connectors `slack/factory` and `github/factory`, set in
  production via `SLACK_CONNECTOR` and `GITHUB_CONNECTOR`. `GITHUB_BOT_USER_ID` is the
  `factory-basehub[bot]` user, so the adapter ignores its own comments.
- **Observer:** a local-only UI (`pnpm dev`, then http://localhost:3000). Set
  `SOFTWARE_FACTORY_BOARD_URL` to watch the deployed board; your Vercel login
  authenticates.
