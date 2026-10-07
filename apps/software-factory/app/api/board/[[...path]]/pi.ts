import type { Watcher } from "vboard";
import type { byPi, tellPi } from "./agent";

/** A thread root as watchers see it: its labels and who reacted with what. */
type Root = { labels: Record<string, string>; reactions?: Record<string, string[]> };

/**
 * Whether a thread is parked as a todo (see todo.ts): Pi leaves it alone. The :todo:
 * reaction counts as well as the label, so a reply that lands before the todo watcher
 * has labeled the thread doesn't wake Pi.
 */
export const parked = (root: Root) =>
  root.labels.todo === "yes" || (root.reactions?.todo?.length ?? 0) > 0;

/**
 * Pi watches every thread worth acting on (`kinds`: bugs, features, questions; not noise):
 * it gets the thread once triage gives it one of those kinds, is told again if the kind
 * changes, and hears when anyone else replies, then reads what's new itself. Not while
 * the thread is parked as a todo.
 */
export function pi(options: { tellPi: typeof tellPi; byPi: typeof byPi; kinds: Record<string, string> }): Watcher {
  const isPiKind = (kind: string | undefined): kind is string => !!kind && Object.hasOwn(options.kinds, kind);
  return {
    tail: `dev --label kind=${Object.keys(options.kinds).join("|")}`,
    run: async ({ event, board }) => {
      const message = event.message;
      if (!message) return;
      const kind = event.type === "labels.changed" ? event.payload.set.kind : undefined;
      if (isPiKind(kind) && message.re === null) {
        if (parked(message)) return;
        await options.tellPi({
          task: "thread",
          thread: message.id,
          key: `kind-${kind}`,
          message: `There's ${options.kinds[kind]} in board thread #${message.id}.`,
        });
      } else if (event.type === "message.posted" && message.re !== null && !options.byPi(message.re, message.by)) {
        if (parked((await board.thread(message.re)).message)) return;
        await options.tellPi({
          task: "thread",
          thread: message.re,
          key: `news-${message.id}`,
          message: `There's new activity in board thread #${message.re}.`,
        });
      }
    },
  };
}
