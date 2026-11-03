import type { Watcher } from "@vercel/board";
import { byAgent } from "./identity";
import { taskMessage, tell } from "./sessions";

// What the board sees of the agent: the watchers that hand it work. The board route spreads these into
// its `watch`, so another agent swaps in by exporting watchers of its own.

/** A watcher per channel, keyed by its ID: every message posted there wakes the agent. */
export function watchers(channels: Record<string, string>): Record<string, Watcher> {
  return Object.fromEntries(Object.entries(channels).map(([id, channel]) => [id, hear(channel)]));
}

/**
 * Every message posted in `channel` wakes the agent, and its instructions decide whether it has anything
 * to add. Of its own messages, only the ones a schedule posted (its reminders to itself) do.
 */
function hear(channel: string): Watcher {
  return {
    tail: channel,
    run: async ({ event, board }) => {
      const message = event.message;
      if (event.type !== "message.posted" || !message) return;
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
