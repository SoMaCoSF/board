import type { Watcher } from "vboard";
import { byWatcher, taskMessage, type byPi, type tellPi } from "./agent.ts";
import { isPiKind, PI_KINDS, piTask, scheduled, scheduledThread } from "./kinds.ts";
import { parked } from "./todo.ts";

/**
 * Pi watches every thread worth acting on (bugs, features, questions, tasks; not noise): it
 * gets the thread once triage gives it one of those kinds, is told again if the kind
 * changes, and hears when anyone else replies, then reads what's new itself. Not while
 * the thread is parked as a todo.
 */
export function pi(options: { tellPi: typeof tellPi; byPi: typeof byPi }): Watcher {
  return {
    tail: `dev --label kind=${PI_KINDS.join("|")}`,
    run: async ({ event, board }) => {
      const message = event.message;
      if (!message) return;
      const kind =
        event.type === "labels.changed"
          ? event.payload.set.kind
          : event.type === "message.posted"
            ? scheduledThread(message) ?? undefined
            : undefined;
      if (kind && isPiKind(kind) && message.re === null) {
        if (parked(message)) return;
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
        (scheduled(message) || !options.byPi(message.re, message.by)) &&
        !byWatcher(message.by)
      ) {
        if (parked((await board.thread(message.re)).message)) return;
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
