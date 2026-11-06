import assert from "node:assert/strict";
import { test } from "node:test";
import { pi } from "../app/api/board/[[...path]]/pi.ts";

function harness() {
  const told = [];
  const watcher = pi({ tellEve: async (input) => { told.push(input); } });
  const board = { reply: async () => {} };
  return { told, run: (event) => watcher.run({ event, board }) };
}

const person = { actor: "slack:user:U08TGDSH4VC", principal: "slack:user:U08TGDSH4VC", profile: null, session: null };

/** Triage giving a new thread a kind, the way Eve first hears of it. */
const triaged = (text, kind = "task") => ({
  type: "labels.changed",
  payload: { set: { kind } },
  message: { id: "7661", re: null, text, labels: { kind }, by: person, origin: null, author: { name: "Nicolás Montone" } },
});

/** A person's reply in a thread Eve already has. */
const replied = (text) => ({
  type: "message.posted",
  message: { id: "7683", re: "7661", text, labels: {}, by: person },
});

test("a thread that opens by @mentioning another bot isn't Eve's (board #7775)", async () => {
  // Board #7661: "@hacker Do a full security review…" was triaged a task, and Eve took it on.
  // hacker hadn't posted yet, so the board couldn't resolve the mention: only the text says who it's for.
  for (const text of [
    "@hacker Do a full security review of Board: three repos that work together.",
    "@hacker @sre can you two look at this?",
    "@[slack:user:U0BJ59KAFM5] Do a full security review",
  ]) {
    const h = harness();
    await h.run(triaged(text));
    assert.deepEqual(h.told, [], text);
  }
});

test("a reply that @mentions someone else doesn't wake Eve", async () => {
  const h = harness();
  await h.run(replied("@hacker :please:"));
  assert.deepEqual(h.told, []);
});

test("a thread for the factory still reaches Eve, mentions and all", async () => {
  for (const text of [
    "Do a full security review of Board",
    "factory, do a full security review of Board",
    "@factory do a full security review",
    "@vboard-factory/keen-finch-7661 can you take this?",
    "@JB @factory can one of you look at this?",
    "@JB and factory: vb read crashes on an attachment",
    "vb read crashes on an attachment, cc @JB",
  ]) {
    const h = harness();
    await h.run(triaged(text, "bug"));
    assert.equal(h.told.length, 1, text);
    assert.equal(h.told[0].thread, "7661");
    assert.equal(h.told[0].key, "kind-bug");
  }
  const h = harness();
  await h.run(replied("thanks, also check the CLI"));
  assert.deepEqual(h.told.map((t) => t.key), ["news-7683"]);
});
