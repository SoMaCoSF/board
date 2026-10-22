import type { Watcher } from "vboard";
import { byAgent, byPi, byTeam, taskMessage, type tellPi } from "./agent.ts";
import type { classifyThread } from "./classify";
import { isPiKind, PI_KINDS, piTask, scheduled, scheduledThread } from "./kinds.ts";
import { asksPi, isDraft, reviewStarts } from "./review.ts";

/**
 * Every non-PR dev thread gets a kind, judged from all of it whenever a person posts,
 * so a chat that turns into a bug report becomes kind=bug. Bugs get 🐛 in Slack too.
 * An agent's post (a coding agent sharing progress) isn't judged: a thread an agent
 * opens gets a kind once a person replies in it.
 */
export function triage(options: { classify: typeof classifyThread }): Watcher {
  return {
    tail: "dev",
    run: async ({ event, board }) => {
      const message = event.message;
      if (
        event.type !== "message.posted" ||
        !message ||
        !byTeam(message.by) ||
        byPi(message.re ?? message.id, message.by) ||
        byAgent(message.by) ||
        scheduledThread(message)
      ) {
        return;
      }
      const thread = await board.thread(message.re ?? message.id);
      if (thread.message.labels.pr) {
        return;
      }
      const kind = await options.classify(
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
  };
}

/**
 * Pi watches every thread worth acting on (bugs, features, questions, tasks; not noise): it
 * gets the thread once triage gives it one of those kinds, is told again if the kind
 * changes, and hears when anyone else replies, then reads what's new itself.
 */
export function pi(options: { tellPi: typeof tellPi }): Watcher {
  return {
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
        await options.tellPi({
          board,
          task: "thread",
          thread: message.id,
          key: `kind-${kind}`,
          message: taskMessage(piTask(kind), message),
        });
      } else if (
        event.type === "message.posted" &&
        message.re !== null &&
        byTeam(message.by) &&
        (scheduled(message) || !byPi(message.re, message.by))
      ) {
        await options.tellPi({
          board,
          task: "thread",
          thread: message.re,
          key: `news-${message.id}`,
          message: `There's new activity in board thread #${message.re}.`,
        });
      }
    },
  };
}

/**
 * Pi reviews PRs once they're ready: a PR opened ready when its thread opens in `dev`, a
 * draft when it's marked ready (its root relabeled state=open). Pi hears when anyone but a
 * bot (Vercel's deploy comments, CI) replies there, except that in a draft only a reply
 * asking Pi itself, or a reminder Pi scheduled, wakes it. Only PR threads: `--label pr` matches a reply by its root's
 * labels too.
 */
export function reviewPi(options: { tellPi: typeof tellPi }): Watcher {
  return {
    tail: "dev --label pr",
    run: async ({ event, board }) => {
      const message = event.message;
      if (!message) {
        return;
      }
      if (reviewStarts(event)) {
        await options.tellPi({
          board,
          task: "review",
          thread: message.id,
          key: "pr",
          message: `There's a pull request to review in board thread #${message.id}.`,
        });
      } else if (
        event.type === "message.posted" &&
        message.re !== null &&
        byTeam(message.by) &&
        (scheduled(message) || !byPi(message.re, message.by)) &&
        !message.author?.handle.endsWith("[bot]") &&
        // In a draft, a reminder Pi scheduled for itself still reaches it.
        ((scheduled(message) && byPi(message.re, message.by)) ||
          asksPi(message.re, message.text) ||
          !isDraft((await board.thread(message.re)).message.labels))
      ) {
        await options.tellPi({
          board,
          task: "review",
          thread: message.re,
          key: `news-${message.id}`,
          message: `There's new activity in board thread #${message.re}.`,
        });
      }
    },
  };
}
