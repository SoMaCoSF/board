import { board } from "@vercel/board";
import { a2, fsBlob } from "@vercel/board/backend-a2";
import { vercelBlob } from "@vercel/board/backend-a2/blob-vercel";
import { github, repos } from "@vercel/board/sync-github";
import { channels, slack } from "@vercel/board/sync-slack";
import { wakeAgent } from "@/agent/lib/wake";
import { ownRepo } from "@/lib/github";
import { queues, store } from "./a2";
import { appLogin, withoutForksOrOwn } from "./github";

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const own = ownRepo();

/** This factory's Vercel Connect connectors. */
export const connectors = { github: "github/factory", slack: "slack/factory" };

/** Each repo (`owner/name`, as GitHub writes it) and the board channel its PRs and issues come into. */
export const repoChannels: Record<string, string> = {
  ...(own ? { [own]: "dev/factory" } : {}),
  // "acme/web": "dev",
};

/** Each Slack channel (a name or an ID) and the board channel it mirrors, both ways. */
export const slackChannels: Record<string, string> = { "#factory": "dev" };

const backend = a2({
  store,
  blob: process.env.VERCEL_ENV ? vercelBlob() : fsBlob(),
  scheduler: queues,
});

export const factory = board({
  backend,
  sync: {
    // Nothing goes back to GitHub: the agent comments there itself, with gh.
    github: github(connectors.github, repos(withoutForksOrOwn(repoChannels, appLogin(connectors.github)))),
    slack: slack(connectors.slack, channels(slackChannels)),
  },
  watch: {
    // Every message in dev and the channels under it, with GitHub access to the repos above.
    factory: { tail: "dev/", run: (context) => wakeAgent(context, { github: connectors.github, repos: Object.keys(repoChannels) }) },
  },
});

export const GET = factory.fetch, POST = factory.fetch;
export const scheduler = queues.handler(...backend.servers);
