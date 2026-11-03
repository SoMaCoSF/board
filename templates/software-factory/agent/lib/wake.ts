import type { WatcherContext } from "@vercel/board";
import { byAgent } from "./identity";
import { taskMessage, tell } from "./sessions";

// What the board sees of the agent: the board route's watcher runs this for each event it tails, so
// another agent swaps in with a wakeAgent of its own.

/**
 * Hands a board event to the agent: every message posted wakes it, and its instructions decide
 * whether it has anything to add. Of its own messages, only the ones a schedule posted (its
 * reminders to itself) do.
 */
export async function wakeAgent({ event, board }: WatcherContext): Promise<void> {
  const message = event.message;
  if (event.type !== "message.posted" || !message) return;
  const thread = message.re ?? message.id;
  if (byAgent(thread, message.by) && message.schedule === undefined) return;
  await tell(board, {
    thread,
    key: `message-${message.id}`,
    message: message.re === null ? taskMessage(message) : `There's a new message, #${message.id}, in board thread #${thread}.`,
  });
}
