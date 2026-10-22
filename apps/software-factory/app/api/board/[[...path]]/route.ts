import { board } from "vboard";
import { slack } from "vboard/adapter-slack";
import { github } from "vboard/adapter-github";
import { vercelBlob } from "vboard/adapter-vercel-blob";
import { queues, store } from "./a2";
import { piTokens, tellPi } from "./agent";
import { classifyThread } from "./classify";
import { pi, reviewPi, triage } from "./pi";
import { security } from "./security";
import { shipit } from "./shipit";
import { autoland } from "./autoland";
import { owner } from "./owner";
import { crosspost } from "./crosspost";
import { guard } from "./guard";
import { renderForSlack } from "./render";
import { boardOnly, unseenPr } from "./quiet";
import { CONNECTOR, REPO } from "./github";
import { vercelTrustedSources } from "./trusted-sources";

// The software factory: vboard running on its own repo and Vercel's Slack. Its log is
// in `a2.ts`; locally there's no VERCEL_ENV, so attachments are files in .a2/attachments.
const env = process.env.VERCEL_ENV;

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const factory = board({
  access: vercelTrustedSources(process.env.VBOARD_TRUSTED_SOURCES),
  store,
  // Attachments (Pi's proof of work) in the project's private Blob store, `vboard-factory-attachments`.
  // Every deployment shares it: a file's ID is random, and only its board can name it.
  blob: env ? vercelBlob() : undefined,
  scheduler: queues,
  sync: {
    // Connect connectors: vboard builds the adapters, and people who sign in
    // (`vb identity link slack`) post as themselves.
    slack: slack({
      adapter: "slack/vboard-factory",
      render: renderForSlack,
      channels: {
        // #development-messageboard
        C0C8XN8SQRG: "dev",
      },
    }),
    github: github({
      adapter: CONNECTOR,
      repos: {
        [REPO]: {
          // Inline review threads and "closed by …" replies stay on GitHub and the board,
          // out of Slack: top-level comments, review verdicts and merges still go through.
          // Comments on a PR the board has no thread for stay on GitHub.
          pulls: {
            channel: "dev",
            run: async ({ event, board }) => {
              if (await unseenPr(event, board, "dev")) return;
              await board.sync("dev", event, { noSync: boardOnly(event) });
            },
          },
          issues: "dev",
        },
      },
    }),
  },
  // Every message from Slack, GitHub, or CI is checked for prompt injection before it lands.
  // Shadow mode: a flagged one is labeled guard=injection, and nothing is dropped yet.
  middleware: [guard({ mode: "shadow" })],
  watch: {
    shipit: shipit({ tellPi }),
    // Shadow mode: labels each reviewed factory PR autoland=would|no, and merges nothing.
    autoland: autoland(),
    // A factory PR's root names whose it is: the person who opened its source thread.
    owner: owner(),
    // A factory PR's Slack thread and the Slack thread it was built for link to each other.
    crosspost: crosspost(),
    security: security({ tellPi }),
    "triage-gpt": triage({ classify: classifyThread }),
    pi: pi({ tellPi }),
    "review-pi": reviewPi({ tellPi }),
  },
});

export const { GET, POST } = factory;
// The board's queue also delivers the refreshes of Pi's tokens.
export const scheduler = queues.handler(...factory.servers, piTokens.server);
