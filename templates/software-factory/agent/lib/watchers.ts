import type { Watcher } from "@vercel/board";
import { byAgent } from "./identity";
import { taskMessage, tell } from "./sessions";

// What the board sees of the agent: the watcher that hands it work. The board route puts it in its
// `watch`, under the agent's name, so another agent swaps in with a watcher of its own.

/**
 * The agent, as the board sees it: every message posted in `channels` wakes it, and its instructions
 * decide whether it has anything to add. Of its own messages, only the ones a schedule posted (its
 * reminders to itself) do.
 */
export function hears(channels: string[]): Watcher {
  return {
    // One channel tails just that one; several tail every channel, and the rest are skipped below.
    tail: channels.length === 1 ? channels[0]! : "",
    run: async ({ event, board }) => {
      const message = event.message;
      if (event.type !== "message.posted" || !message || !channels.includes(message.channel)) return;
      const thread = message.re ?? message.id;
      if (byAgent(thread, message.by) && message.schedule === undefined) return;
      await tell(board, {
        thread,
        key: `message-${message.id}`,
        message: message.re === null ? taskMessage(message) : `There's a new message, #${message.id}, in board thread #${thread}.`,
      });
    },
  };
}
