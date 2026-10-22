import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "experimental-a2/store-memory";
import { v0Replies } from "../app/api/board/[[...path]]/replies.ts";

const scheduler = { schedule: async () => {}, handler: () => async () => new Response(null, { status: 204 }) };

/** Replies whose `read` stands in for the paid model call, counting what it reads. */
function counted() {
  const read = [];
  const replies = v0Replies({
    store: memory(),
    scheduler,
    read: async (reply) => {
      read.push(reply.messageId);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  const settled = async () => {
    for (let i = 0; i < 20; i++) {
      await replies.server.drain("chat-c1");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { replies, read, settled };
}

test("v0Replies: duplicate deliveries of a reply, at once or later, read it once", async () => {
  const { replies, read, settled } = counted();
  const reply = { chatId: "c1", messageId: "m1" };

  await Promise.all([replies.finished(reply), replies.finished(reply), replies.finished(reply)]);
  await settled();
  assert.deepEqual(read, ["m1"]);

  // A replay after it was read, even when the model said v0 was still working.
  await replies.finished(reply);
  await settled();
  assert.deepEqual(read, ["m1"]);
});

test("v0Replies: each new reply in a chat is read", async () => {
  const { replies, read, settled } = counted();
  await replies.finished({ chatId: "c1", messageId: "m1" });
  await replies.finished({ chatId: "c1", messageId: "m2" });
  await settled();
  assert.deepEqual(read.sort(), ["m1", "m2"]);
});
