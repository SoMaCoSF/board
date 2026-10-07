import { board } from "vboard";
import { slack } from "vboard/adapter-slack";
import { github } from "vboard/adapter-github";
import { vercelBlob } from "vboard/adapter-vercel-blob";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createGitHubAdapter } from "@chat-adapter/github";
import {
  connectGitHubAdapter,
  connectSlackAdapter,
} from "@vercel/connect/chat";
import { redisHttp } from "experimental-a2/store-redis-http";
import { vercelQueues } from "experimental-a2/scheduler-vercel";
import { byPi, newsMessage, quote, sincePi, taskMessage, tellPi } from "./agent";
import { classifyThread } from "./classify";
import { isPiKind, PI_KINDS, piTask, scheduled, scheduledThread } from "./kinds";
import { fromSecurity, security } from "./security";
import { shipit } from "./shipit";
import { autoland } from "./autoland";
import { owner } from "./owner";
import { crosspost, CROSSPOST_ACTOR } from "./crosspost";
import { renderForSlack } from "./render";

// The software factory: vboard running on its own repo and Vercel's Slack. Locally
// there's no VERCEL_ENV, so the log is SQLite at .a2/dev.db and attachments are
// files in .a2/attachments.
const env = process.env.VERCEL_ENV;

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const slackCredentials = connectSlackAdapter("slack/vboard-factory");
const slackAdapter = createSlackAdapter(slackCredentials);
const slackToken = slackCredentials.botToken;

export const { GET, POST, scheduler } = board({
  store: env
    ? redisHttp({
        url: process.env.KV_REST_API_URL!,
        token: process.env.KV_REST_API_TOKEN!,
        // One Redis serves every environment: a preview never touches production's log.
        keyPrefix: env === "production" ? "vboard-factory" : `vboard-factory:${env}`,
      })
    : undefined,
  // Attachments (Pi's proof of work) in the project's private Blob store, `vboard-factory-attachments`.
  // Every deployment shares it: a file's ID is random, and only its board can name it.
  blob: env ? vercelBlob() : undefined,
  scheduler: vercelQueues({ topic: "vboard-factory" }),
  sync: {
    slack: slack({
      adapter: slackAdapter,
      render: renderForSlack,
      client: async () =>
        slackAdapter.withBotToken(
          typeof slackToken === "function" ? await slackToken() : slackToken,
          () => slackAdapter.webClient,
        ),
      channels: {
        C0C6MNT9LLC: "dev",
      },
    }),
    github: github({
      adapter: createGitHubAdapter({
        ...connectGitHubAdapter("github/vboard-factory"),
        // Connect can't detect the bot's identity, so pin it to prevent echoes.
        botUserId: 338721338,
      }),
      repos: {
        "basehub-ai/vboard": { pulls: "dev", issues: "dev" },
      },
    }),
  },
  watch: {
    shipit: shipit({ tellPi }),
    // Shadow mode: labels each reviewed factory PR autoland=would|no, and merges nothing.
    autoland: autoland(),
    // A factory PR's root names whose it is: the person who opened its source thread.
    owner: owner(),
    // A factory PR's Slack thread and the Slack thread it was built for link to each other.
    crosspost: crosspost(),
    security: security({ tellPi }),
    // Every non-PR dev thread gets a kind, judged from all of it,
    // so a chat that turns into a bug report becomes kind=bug. Bugs get 🐛 in Slack too.
    "triage-gpt": {
      tail: "dev",
      run: async ({ event, board }) => {
        const message = event.message;
        if (
          event.type !== "message.posted" ||
          !message ||
          byPi(message.re ?? message.id, message.by) ||
          message.by.actor === CROSSPOST_ACTOR ||
          scheduledThread(message)
        ) {
          return;
        }
        const thread = await board.thread(message.re ?? message.id);
        if (thread.message.labels.pr) {
          return;
        }
        const kind = await classifyThread(
          [thread.message, ...thread.replies].map((m) => ({
            from: m.author?.name ?? m.by.actor,
            text: m.text,
          })),
        );
        if (thread.message.labels.kind === kind) {
          return;
        }
        await board.label(thread.message.id, { set: { kind } });
        if (kind === "bug") {
          await board.react(thread.message.id, "bug");
        }
      },
    },
    // Pi watches every thread worth acting on (bugs, features, questions, tasks; not noise): it
    // gets the thread once triage gives it one of those kinds, is told again if the kind
    // changes, and hears when anyone else replies, then reads what's new itself.
    pi: {
      tail: `dev --label kind=${PI_KINDS.join("|")}`,
      run: async ({ event, board }) => {
        const message = event.message;
        if (!message) {
          return;
        }
        const kind =
          event.type === "labels.changed"
            ? event.payload.set.kind
            : event.type === "message.posted"
              ? scheduledThread(message) ?? undefined
              : undefined;
        if (kind && isPiKind(kind) && message.re === null) {
          // 👀 from the board right away: Pi's own would come after a sandbox boot and a model turn (~25s).
          const ack = event.type === "labels.changed";
          const [thread] = await Promise.all([
            board.thread(message.id),
            ack ? board.react(message.id, "eyes") : null,
          ]);
          await tellPi({
            task: "thread",
            thread: message.id,
            key: `kind-${kind}`,
            message: `${taskMessage(piTask(kind), message)}${ack ? " It already has your 👀." : ""}\n\n${quote([thread.message, ...thread.replies])}`,
            since: event.createdAt,
          });
        } else if (
          event.type === "message.posted" &&
          message.re !== null &&
          (scheduled(message) || !byPi(message.re, message.by)) &&
          !fromSecurity(message.by) &&
          message.by.actor !== CROSSPOST_ACTOR
        ) {
          const thread = await board.thread(message.re);
          await tellPi({
            task: "thread",
            thread: message.re,
            key: `news-${message.id}`,
            message: newsMessage(message.re, sincePi(message.re, [thread.message, ...thread.replies])),
            since: event.createdAt,
          });
        }
      },
    },
    // Pi reviews PRs: a PR's thread opens in `dev` when it's opened or marked ready, and
    // Pi hears when anyone but a bot (Vercel's deploy comments, CI) replies there. Only PR
    // threads: `--label pr` matches a reply by its root's labels too.
    "review-pi": {
      tail: "dev --label pr",
      run: async ({ event, board }) => {
        const message = event.message;
        if (event.type !== "message.posted" || !message) {
          return;
        }
        if (message.re === null) {
          await tellPi({
            task: "review",
            thread: message.id,
            key: "pr",
            message: `There's a pull request to review in board thread #${message.id}.`,
            since: event.createdAt,
          });
        } else if (
          (scheduled(message) || !byPi(message.re, message.by)) &&
          !message.author?.handle.endsWith("[bot]") &&
          message.by.actor !== CROSSPOST_ACTOR
        ) {
          const thread = await board.thread(message.re);
          await tellPi({
            task: "review",
            thread: message.re,
            key: `news-${message.id}`,
            message: newsMessage(message.re, sincePi(message.re, [thread.message, ...thread.replies])),
            since: event.createdAt,
          });
        }
      },
    },
  },
});
