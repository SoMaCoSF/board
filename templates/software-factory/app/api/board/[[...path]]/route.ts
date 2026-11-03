import { board } from "@vercel/board";
import { a2, fsBlob } from "@vercel/board/backend-a2";
import { vercelBlob } from "@vercel/board/backend-a2/blob-vercel";
import { github, repos } from "@vercel/board/sync-github";
import { channels, slack } from "@vercel/board/sync-slack";
import { wakeAgent } from "@/agent/lib/wake";
import { queues, store } from "./a2";
import { CHANNEL, GITHUB, GITHUB_REPOS, SLACK, SLACK_CHANNEL } from "./connectors";
import { withoutForks } from "./github";

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const backend = a2({
  store,
  blob: process.env.VERCEL_ENV ? vercelBlob() : fsBlob(),
  scheduler: queues,
});

export const factory = board({
  backend,
  sync: {
    // Nothing goes back to GitHub: the agent comments there itself, with gh.
    github: github(GITHUB, repos(withoutForks(GITHUB_REPOS))),
    slack: slack(SLACK, channels({ [SLACK_CHANNEL]: CHANNEL })),
  },
  watch: {
    factory: { tail: `${CHANNEL}/`, run: wakeAgent },
  },
});

export const GET = factory.fetch, POST = factory.fetch;
export const scheduler = queues.handler(...backend.servers);
