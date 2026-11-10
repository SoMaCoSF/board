import { board } from "@vercel/board";
import { render } from "@vercel/board/sync";
import { channels, slack } from "@vercel/board/sync-slack";
import { github, repos } from "@vercel/board/sync-github";
import { byAgent, byBot, byEve, byWatcher, taskMessage, tellEve } from "./agent";
import { classifyThread } from "./classify";
import { isEveKind, EVE_KINDS, eveTask, scheduled, scheduledThread } from "./kinds";
import { security } from "./security";
import { shipit } from "./shipit";
import { autoland } from "./autoland";
import { owner } from "./owner";
import { devMirror, inThread } from "./inthread";
import { guard } from "./guard";
import { renderForSlack } from "./render";
import { issues, pulls } from "./quiet";
import { CONNECTOR, REPO } from "./github";
import { boardName, DEV } from "./harness";
import { eveFetch, eveScope, type EveCall } from "./eve-fetch";

// The software factory: board running on its own repo and Vercel's Slack, on the team's default
// board in Vercel's API, under `vboard/` channels. The API keeps the board, its files and
// schedules, and sync's records; this deployment runs sync and the watchers.
//
// Previews and local dev get a board of their own, so their watchers never answer production's
// threads: every deployment's watchers register on the board they use.
/** Where the vb tool runs Eve's commands; the board's first use, outside them, is a read of its channels. */
const scope = eveScope(() => factory.channels());

/** Runs `fn` as the Eve working on `call.thread`: its requests carry that Eve's session, reach only what Eve uses, and end with `call.signal`. */
export const asEve = <T>(call: EveCall, fn: () => Promise<T>) => scope.asEve(call, fn);

let oidc: (() => Promise<string>) | null = null;
const token = async () => {
  oidc ??= (await import("@vercel/oidc")).getVercelOidcToken;
  return oidc();
};

export const factory = board({
  ...(boardName() ? { name: boardName() } : {}),
  // As this deployment's project, with its OIDC token; an Eve's session while it's one of Eve's.
  fetch: eveFetch({ token, call: scope.call }),
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
          C0C8XN8SQRG: devMirror(DEV),
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
    // Every non-PR `vboard/dev` thread gets a kind, judged from all of it whenever a person posts,
    // so a chat that turns into a bug report becomes kind=bug. Bugs get 🐛 in Slack too.
    // An agent's post (a coding agent sharing progress) isn't judged: a thread an agent
    // opens gets a kind once a person replies in it.
    "triage-gpt": {
      tail: DEV,
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
    // Eve watches every thread worth acting on (bugs, features, questions, tasks; not noise): it
    // gets the thread once triage gives it one of those kinds, is told again if the kind
    // changes, and hears when anyone else replies, then reads what's new itself.
    pi: {
      tail: `${DEV} --label kind=${EVE_KINDS.join("|")}`,
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
        if (kind && isEveKind(kind) && message.re === null) {
          await tellEve({
            board,
            task: "thread",
            thread: message.id,
            key: `kind-${kind}`,
            message: taskMessage(eveTask(kind), message),
          });
        } else if (
          event.type === "message.posted" &&
          message.re !== null &&
          (scheduled(message) || !byEve(message.re, message.by)) &&
          !byWatcher(message.by)
        ) {
          await tellEve({
            board,
            task: "thread",
            thread: message.re,
            key: `news-${message.id}`,
            message: `There's new activity in board thread #${message.re}.`,
          });
        }
      },
    },
    // Eve reviews each PR, drafts included, when its thread opens in `vboard/dev`, and hears when anyone
    // but a bot (Vercel's deploy comments, CI) replies there. Only PR threads: `--label pr`
    // matches a reply by its root's labels too.
    "review-pi": {
      tail: `${DEV} --label pr`,
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
          !byBot(message.author) &&
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

