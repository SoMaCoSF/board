import type { Watcher } from "vboard";
import type { tellPi } from "./agent";

const TODO = "todo";

/** A person on Slack or GitHub, not a deployment acting as one. */
const human = (principal: string) =>
  principal.startsWith("slack:user:") || principal.startsWith("github:user:");

/**
 * A person's :todo: reaction on a thread's root labels it `todo=yes`: something to do
 * later, so Pi stops acting on it (`vb read dev --label todo=yes` lists them). Removing
 * the last :todo: unsets the label and hands the thread back to Pi, if it's one Pi works.
 */
export function todo(options: { tellPi: typeof tellPi; kinds: Record<string, string> }): Watcher {
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
      if ((root.reactions?.[TODO]?.length ?? 0) > 0 || root.labels.todo === undefined) return;
      await board.label(root.id, { unset: ["todo"] });
      const kind = root.labels.kind;
      if (kind && Object.hasOwn(options.kinds, kind)) {
        await options.tellPi({
          task: "thread",
          thread: root.id,
          key: `todo-removed-${event.index}`,
          message: `Board thread #${root.id} is no longer parked as a todo: there's ${options.kinds[kind]} in it to act on.`,
        });
      }
    },
  };
}
