import { board } from "vboard/server";
import { slack } from "vboard/slack";
import { github } from "vboard/github";
import { vercelBlob } from "vboard/blob";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createGitHubAdapter } from "@chat-adapter/github";
import {
  connectGitHubAdapter,
  connectSlackAdapter,
} from "@vercel/connect/chat";
import { redisHttp } from "experimental-a2/store-redis-http";
import { vercelQueues } from "experimental-a2/scheduler-vercel";
import { experimental_evaluate as evaluate } from "ai";
import { byPi, tellPi } from "./agent";

/** The kinds of thread Pi acts on, and how it's told about one. Noise it ignores. */
const PI_TASKS = {
  bug: "a bug report",
  feature: "a feature request",
  question: "a question",
} as const;
const PI_KINDS = Object.keys(PI_TASKS) as (keyof typeof PI_TASKS)[];
const isPiKind = (kind: string): kind is keyof typeof PI_TASKS => kind in PI_TASKS;

// The software factory: vboard running on its own repo and BaseHub's Slack. Locally
// there's no VERCEL_ENV, so the log is SQLite at .a2/dev.db and attachments are
// files in .a2/attachments.
const env = process.env.VERCEL_ENV;

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

export const { GET, POST, scheduler } = board({
  store: env
    ? redisHttp({
        url: process.env.KV_REST_API_URL!,
        token: process.env.KV_REST_API_TOKEN!,
        // One Redis serves every environment: a preview never touches production's log.
        keyPrefix: env === "production" ? "vboard" : `vboard:${env}`,
      })
    : undefined,
  // Attachments (Pi's proof of work) in the project's private Blob store, `vboard-attachments`.
  // Every deployment shares it: a file's ID is random, and only its board can name it.
  blob: env ? vercelBlob() : undefined,
  // GitHub can't take files, so its comments link them, signed (images show inline).
  // Every environment links production's board: it shares the Blob store and the secret.
  attachmentLinks: process.env.VBOARD_LINK_SECRET
    ? { secret: process.env.VBOARD_LINK_SECRET, url: "https://vboard-basehub.vercel.app/api/board" }
    : undefined,
  scheduler: vercelQueues({ topic: "vboard" }),
  sync: {
    slack: slack({
      adapter: createSlackAdapter({
        ...connectSlackAdapter("slack/factory"),
      }),
      channels: {
        "#sf-prs": "prs",
        // #sf-firehose is private, and the app can't look up private channels by name.
        C0C5WV6FZGD: "firehose",
      },
    }),
    github: github({
      adapter: createGitHubAdapter({
        ...connectGitHubAdapter("github/factory"),
        // factory-basehub[bot]. Connect can't detect it, and without it the bot replies to itself.
        botUserId: 336642991,
      }),
      repos: {
        "basehub-ai/vboard": { pulls: "prs", issues: "firehose" },
      },
    }),
  },
  watch: {
    // Every firehose thread (Slack and GitHub issues) gets a kind, judged from all of it,
    // so a chat that turns into a bug report becomes kind=bug. Bugs get 🐛 in Slack too.
    triage: {
      tail: "firehose",
      run: async ({ event, board }) => {
        const message = event.message;
        if (
          event.type !== "message.posted" ||
          !message ||
          byPi(message.re ?? message.id, message.by)
        ) {
          return;
        }
        const thread = await board.thread(message.re ?? message.id);
        const { answers } = await evaluate({
          model: "typesafe-ai/jev",
          state: [thread.message, ...thread.replies].map((m) => ({
            from: m.author?.name ?? m.by.actor,
            text: m.text,
          })),
          questions: {
            kind: {
              type: "choice",
              instructions:
                "A conversation with the team that builds vboard, a message board library and CLI. What is it, as a whole?",
              criteria: {
                bug: "Something in vboard is broken or behaves wrongly",
                feature: "A request for something vboard doesn't do yet",
                question: "Someone asking how something works",
                noise: "Chatter, an announcement, or nothing to act on",
              },
            },
          },
        });
        const kind = answers.kind.choice;
        if (thread.message.labels.kind === kind) {
          return;
        }
        await board.label(thread.message.id, { set: { kind } });
        if (kind === "bug") {
          await board.react(thread.message.id, "bug");
        }
      },
    },
    // Pi watches every thread worth acting on (bugs, features, questions; not noise): it
    // gets the thread once triage gives it one of those kinds, is told again if the kind
    // changes, and hears when anyone else replies, then reads what's new itself.
    pi: {
      tail: `firehose --label kind=${PI_KINDS.join("|")}`,
      run: async ({ event }) => {
        const message = event.message;
        if (!message) {
          return;
        }
        const kind = event.type === "labels.changed" ? event.payload.set.kind : undefined;
        if (kind && isPiKind(kind) && message.re === null) {
          await tellPi({
            task: "thread",
            thread: message.id,
            key: `kind-${kind}`,
            message: `There's ${PI_TASKS[kind]} in board thread #${message.id}.`,
          });
        } else if (
          event.type === "message.posted" &&
          message.re !== null &&
          !byPi(message.re, message.by)
        ) {
          await tellPi({
            task: "thread",
            thread: message.re,
            key: `news-${message.id}`,
            message: `There's new activity in board thread #${message.re}.`,
          });
        }
      },
    },
    // Pi reviews PRs: a PR's thread opens in `prs` when it's opened or marked ready, and
    // Pi hears when anyone but a bot (Vercel's deploy comments, CI) replies there. Only PR
    // threads: `--label pr` matches a reply by its root's labels too, so a hand-posted
    // thread in `prs` never wakes Pi.
    review: {
      tail: "prs --label pr",
      run: async ({ event }) => {
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
          });
        } else if (
          !byPi(message.re, message.by) &&
          !message.author?.handle.endsWith("[bot]")
        ) {
          await tellPi({
            task: "review",
            thread: message.re,
            key: `news-${message.id}`,
            message: `There's new activity in board thread #${message.re}.`,
          });
        }
      },
    },
  },
});
