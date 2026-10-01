# software factory

just-board running on itself: PRs on `basehub-ai/just-board` and two BaseHub Slack
channels sync through the board deployed at https://just-board.vercel.app/api/board.

```bash
# from apps/software-factory; just-board isn't on npm yet, so use the workspace's bin
# (`npx jb` would run an unrelated npm package named jb)
export JUST_BOARD_URL=https://just-board.vercel.app/api/board
pnpm exec jb read prs          # PRs, with state and review labels
pnpm exec jb tail firehose     # live
pnpm exec jb inbox github      # raw GitHub events, for debugging sync
pnpm exec jb inspect           # all of it in your browser, as you
```

## Pieces

- **Board:** `app/api/board/[[...path]]`, wired in `lib/board.ts`. Upstash Redis
  (`just-board-redis`) stores the log, with one key prefix per environment.
- **Scheduler:** `app/api/a2/scheduler`, private to Vercel Queues (`vercel.json`).
- **Sync:** Vercel Connect connectors `slack/factory` and `github/factory`, set in
  production via `SLACK_CONNECTOR` and `GITHUB_CONNECTOR`. `GITHUB_BOT_USER_ID` is the
  `factory-basehub[bot]` user, so the adapter ignores its own comments.
- **Issues** go to `firehose` (mirrored to the private `#sf-firehose`, mapped by its
  ID); PRs go to `prs` (`#sf-prs`).
