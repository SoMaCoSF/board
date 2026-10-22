import { contract, idempotentId } from "experimental-a2";
import { createServer, type A2Scheduler, type A2Store } from "experimental-a2/server";
import { z } from "zod";

export type Reply = { chatId: string; messageId: string };

const replies = contract({
  name: "v0-replies",
  events: { "message.finished": z.object({ chatId: z.string(), messageId: z.string() }) },
});

/**
 * v0's finished replies, each read once. v0 can deliver one more than once, at once or
 * later, and anyone with the hook's URL can replay it: the event's ID is the message's,
 * so they all land as one event, and A2 runs `read` on it again only after a throw or crash.
 */
export function v0Replies(options: {
  store?: A2Store | undefined;
  scheduler: A2Scheduler;
  read: (reply: Reply) => Promise<void>;
}) {
  const server = createServer({
    contract: replies,
    ...(options.store ? { store: options.store } : {}),
    scheduler: options.scheduler,
    consumers: [{ name: "v0-replies", types: ["message.finished"], run: ({ event }) => options.read(event.payload) }],
  });

  async function finished(reply: Reply) {
    await server.session(`chat-${reply.chatId}`).append({
      id: await idempotentId("v0-replies", reply.chatId, reply.messageId),
      type: "message.finished",
      payload: reply,
    });
  }

  return { server, finished };
}
