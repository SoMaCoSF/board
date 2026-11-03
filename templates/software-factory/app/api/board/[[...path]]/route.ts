import { board } from "@vercel/board";
import { a2, fsBlob } from "@vercel/board/backend-a2";
import { vercelBlob } from "@vercel/board/backend-a2/blob-vercel";
import { github } from "@vercel/board/sync-github";
import { channels, slack } from "@vercel/board/sync-slack";
import { wakeAgent } from "@/agent/lib/wake";
import { queues, store } from "./a2";
import { CHANNEL, GITHUB, SLACK, SLACK_CHANNEL } from "./connectors";
import { fromGitHub } from "./github";

// The factory's board: everything it syncs and watches is configured here. The agent is in
// agent/, and reaches the board only through the watchers it exports.

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const backend = a2({
  store,
  // Attachments, like the agent's screenshots, in the project's private Blob store. Locally, files in .a2/attachments.
  blob: process.env.VERCEL_ENV ? vercelBlob() : fsBlob(),
  scheduler: queues,
});

export const factory = board({
  backend,
  sync: {
    github: github(GITHUB, fromGitHub(CHANNEL)),
    // Two-way: Slack threads come in, and the board's replies go back to them. Until the connector
    // exists, it waits quietly, and starts within a minute of its attach.
    slack: slack(SLACK, channels({ [SLACK_CHANNEL]: CHANNEL })),
  },
  watch: {
    // Every message in dev and the channels under it wakes the agent: the team's work, and in
    // dev/factory, the factory's own.
    factory: { tail: `${CHANNEL}/`, run: wakeAgent },
  },
});

export const GET = factory.fetch, POST = factory.fetch;
export const scheduler = queues.handler(...backend.servers);
