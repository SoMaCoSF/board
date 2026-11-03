import type { WatcherContext } from "@vercel/board";
import { byAgent } from "./identity";
import { sendToAgent } from "./sessions";

/**
 * All the board sees of the agent: it hands over every message posted where the watcher tails, and
 * reactions to the agent's own messages. The agent reads the thread and decides what each needs.
 */
export async function wakeAgent({ event, board }: WatcherContext): Promise<void> {
  const message = event.message;
  if (!message) return;
  const thread = message.re ?? message.id;
  let text: string;
  if (event.type === "message.posted") {
    // Its own messages don't wake it, except the reminders it schedules for itself.
    if (byAgent(thread, message.by) && message.schedule === undefined) return;
    text = message.re ? `New message #${message.id} in board thread #${thread}.` : `New board thread #${thread}.`;
  } else if (event.type === "reaction.added") {
    if (!byAgent(thread, message.by) || byAgent(thread, event.payload.by)) return;
    text = `${event.actor?.name ?? "Someone"} reacted :${event.payload.emoji}: to your message #${message.id} in board thread #${thread}.`;
  } else return;
  await sendToAgent(board, { thread, key: event.cursor, text });
}
