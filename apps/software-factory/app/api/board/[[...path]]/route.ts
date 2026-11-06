import { board } from "@vercel/board";
import { a2, fsBlob } from "@vercel/board/backend-a2";
import { render } from "@vercel/board/sync";
import { channels, slack } from "@vercel/board/sync-slack";
import { github, repos } from "@vercel/board/sync-github";
import { vercelBlob } from "@vercel/board/backend-a2/blob-vercel";
import { queues, store } from "./a2";
import { byAgent, byEve, byWatcher, tellEve } from "./agent";
import { classifyThread } from "./classify";
import { scheduled, scheduledThread } from "./kinds";
import { security } from "./security";
import { pi } from "./pi";
import { shipit } from "./shipit";
import { autoland } from "./autoland";
import { owner } from "./owner";
import { devMirror, inThread } from "./inthread";
import { guard } from "./guard";
import { renderForSlack } from "./render";
import { issues, pulls } from "./quiet";
import { CONNECTOR, REPO } from "./github";
import { vercelTrustedSources } from "./trusted-sources";

// The software factory: board running on its own repo and Vercel's Slack. Its log is
// in `a2.ts`; locally there's no VERCEL_ENV, so attachments are files in .a2/attachments.
const env = process.env.VERCEL_ENV;

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const backend = a2({
  store,
  // Attachments (Eve's proof of work) in the project's private Blob store, `vboard-factory-attachments`.
  // Every deployment shares it: a file's ID is random, and only its board can name it.
  blob: env ? vercelBlob() : fsBlob(),
  scheduler: queues,
});

const factory = board({
  backend,
  // Factories elsewhere that may use this board, by project and team.
  access: vercelTrustedSources(process.env.BOARD_TRUSTED_SOURCES),
  // Every message from Slack, GitHub, or CI is checked for prompt injection before it lands.
  // Shadow mode: a flagged one is labeled guard=injection, and nothing is dropped yet.
  middleware: [guard({ mode: "shadow" })],
  sync: {
    // Connect connectors: board builds the adapters.
    slack: slack(
      "slack/vboard-factory",
      render(
        renderForSlack,
        channels({
          // #development-messageboard. A factory PR's root doesn't start a thread there: it lives in its source thread.
          C0C8XN8SQRG: devMirror("dev"),
        }),
      ),
    ),
    // GitHub comes in and nothing goes back: PR and issue threads' replies stay in Slack and on the board.
    github: github(CONNECTOR, repos({ [REPO]: { pulls, issues } })),
  },
  watch: {
    shipit: shipit({ tellEve }),
    // Shadow mode: labels each reviewed factory PR autoland=would|no, and merges nothing.
    autoland: autoland(),
    // A factory PR's root names whose it is: the person who opened its source thread.
    owner: owner(),
    // A factory PR's one-line message goes in the thread it was built for, whose root's PR emoji follows its state.
    "in-thread": inThread(),
    security: security({ tellEve }),
    // Every non-PR dev thread gets a kind, judged from all of it whenever a person posts,
    // so a chat that turns into a bug report becomes kind=bug. Bugs get 🐛 in Slack too.
    // An agent's post (a coding agent sharing progress) isn't judged: a thread an agent
    // opens gets a kind once a person replies in it.
    "triage-gpt": {
      tail: "dev",
      run: async ({ event, board }) => {
        const message = event.message;
        if (
          event.type !== "message.posted" ||
          !message ||
          byEve(message.re ?? message.id, message.by) ||
          byWatcher(message.by) ||
          byAgent(message.by) ||
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
    // Eve hears about every thread worth acting on, unless it's addressed to someone else.
    pi: pi({ tellEve }),
    // Eve reviews each PR, drafts included, when its thread opens in `dev`, and hears when anyone
    // but a bot (Vercel's deploy comments, CI) replies there. Only PR threads: `--label pr`
    // matches a reply by its root's labels too.
    "review-pi": {
      tail: "dev --label pr",
      run: async ({ event, board }) => {
        const message = event.message;
        if (!message) {
          return;
        }
        if (event.type === "message.posted" && message.re === null) {
          await tellEve({
            board,
            task: "review",
            thread: message.id,
            key: "pr",
            message: `There's a pull request to review in board thread #${message.id}.`,
          });
        } else if (
          event.type === "message.posted" &&
          message.re !== null &&
          (scheduled(message) || !byEve(message.re, message.by)) &&
          !message.author?.handle.endsWith("[bot]") &&
          !byWatcher(message.by)
        ) {
          await tellEve({
            board,
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

export const GET = factory.fetch, POST = factory.fetch;
export const scheduler = queues.handler(...backend.servers);
