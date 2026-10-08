import type { Watcher } from "vboard";
import type { tellPi } from "./agent";
import { isPiKind, piTask } from "./kinds.ts";

const TODO = "todo";

/**
 * A person on Slack or GitHub, not a deployment acting as one. Only their :todo: counts,
 * both for parking (`parked`) and for the label and hand-back (`todo`): if the two
 * disagreed, a :todo: from anyone else would park a thread that nothing ever unparks.
 */
export const human = (id: string) => id.startsWith("slack:user:") || id.startsWith("github:user:");

/** People's :todo: reactions on a root. */
const todos = (root: Root) => (root.reactions?.[TODO] ?? []).filter(human);

/** A thread root as watchers see it: its labels and who reacted with what. */
type Root = { labels: Record<string, string>; reactions?: Record<string, string[]> };

/**
 * Whether a thread is parked as a todo: Pi leaves it alone. A person's :todo: reaction
 * counts as well as the label, so a reply that lands before the todo watcher has labeled
 * the thread doesn't wake Pi.
 */
export const parked = (root: Root) => root.labels.todo === "yes" || todos(root).length > 0;

/**
 * A person's :todo: reaction on a thread's root labels it `todo=yes`: something to do
 * later, so Pi stops acting on it (`vb read dev --label todo=yes` lists them). Removing
 * the last person's :todo: unsets the label and hands the thread back to Pi, if it's one Pi works.
 */
export function todo(options: { tellPi: typeof tellPi }): Watcher {
  return {
    tail: "dev",
    run: async ({ event, board }) => {
      const root = event.message;
      if (
        (event.type !== "reaction.added" && event.type !== "reaction.removed") ||
        event.payload.emoji !== TODO ||
        !human(event.payload.by.principal) ||
        !root ||
        root.re !== null
      ) return;
      if (event.type === "reaction.added") {
        if (root.labels.todo !== "yes") await board.label(root.id, { set: { todo: "yes" } });
        return;
      }
      if (todos(root).length > 0 || root.labels.todo === undefined) return;
      await board.label(root.id, { unset: ["todo"] });
      const kind = root.labels.kind;
      if (kind && isPiKind(kind)) {
        await options.tellPi({
          task: "thread",
          thread: root.id,
          key: `todo-removed-${event.index}`,
          message: `Board thread #${root.id} is no longer parked as a todo: there's ${piTask(kind)} in it to act on.`,
        });
      }
    },
  };
}
