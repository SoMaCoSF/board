import assert from "node:assert/strict";
import { test } from "node:test";
import { todo } from "../app/api/board/[[...path]]/todo.ts";
import { pi, parked } from "../app/api/board/[[...path]]/pi.ts";
import { byPi } from "../app/api/board/[[...path]]/agent.ts";

const KINDS = { bug: "a bug report", feature: "a feature request", question: "a question" };
const person = { actor: "slack:user:U123", principal: "slack:user:U123", profile: null, session: null };

const root = (over = {}) => ({ id: 854, re: null, labels: { kind: "feature" }, reactions: {}, by: person, ...over });

function harness(threadRoot = root()) {
  const told = [];
  const labels = [];
  const board = {
    label: async (id, change) => { labels.push({ id, ...change }); },
    thread: async () => ({ message: threadRoot, replies: [] }),
  };
  const tellPi = async input => { told.push(input); };
  return {
    told,
    labels,
    todo: event => todo({ tellPi, kinds: KINDS }).run({ event, board }),
    pi: event => pi({ tellPi, byPi, kinds: KINDS }).run({ event, board }),
  };
}

const reaction = (type, message, by = person, emoji = "todo") => ({
  index: 9, type, payload: { emoji, from: "slack", by }, message,
});

test("a person's :todo: on a thread's root labels it todo=yes", async () => {
  const h = harness();
  await h.todo(reaction("reaction.added", root({ reactions: { todo: [person.actor] } })));
  assert.deepEqual(h.labels, [{ id: 854, set: { todo: "yes" } }]);
  assert.deepEqual(h.told, []);
});

test(":todo: on a reply, another emoji, or a deployment's reaction does nothing", async () => {
  const h = harness();
  await h.todo(reaction("reaction.added", root({ id: 900, re: 854 })));
  await h.todo(reaction("reaction.added", root(), person, "eyes"));
  await h.todo(reaction("reaction.added", root(), { ...person, principal: "vercel:project:pi:production" }));
  assert.deepEqual(h.labels, []);
});

test("removing the last :todo: unsets the label and hands the thread back to Pi", async () => {
  const h = harness();
  await h.todo(reaction("reaction.removed", root({ labels: { kind: "feature", todo: "yes" } })));
  assert.deepEqual(h.labels, [{ id: 854, unset: ["todo"] }]);
  assert.equal(h.told.length, 1);
  assert.equal(h.told[0].thread, 854);
  assert.match(h.told[0].message, /no longer parked.*a feature request/);
});

test("the thread stays parked while someone else's :todo: remains, and noise isn't handed to Pi", async () => {
  const h = harness();
  await h.todo(reaction("reaction.removed", root({ labels: { kind: "feature", todo: "yes" }, reactions: { todo: ["slack:user:U9"] } })));
  await h.todo(reaction("reaction.removed", root({ labels: { kind: "noise", todo: "yes" } })));
  assert.deepEqual(h.labels, [{ id: 854, unset: ["todo"] }]);
  assert.deepEqual(h.told, []);
});

test("Pi isn't told about a parked thread's kind or its replies", async () => {
  const kindSet = message => ({ index: 1, type: "labels.changed", payload: { set: { kind: "feature" }, unset: [] }, message });
  const reply = { id: 1114, re: 854, labels: {}, reactions: {}, by: person };
  const posted = { index: 2, type: "message.posted", payload: {}, message: reply };

  const byLabel = harness(root({ labels: { kind: "feature", todo: "yes" } }));
  await byLabel.pi(kindSet(root({ labels: { kind: "feature", todo: "yes" } })));
  await byLabel.pi(posted);
  assert.deepEqual(byLabel.told, []);

  // Before the todo watcher has labeled it, the reaction alone parks it.
  const byReaction = harness(root({ reactions: { todo: [person.actor] } }));
  await byReaction.pi(posted);
  assert.deepEqual(byReaction.told, []);

  const open = harness();
  await open.pi(kindSet(root()));
  await open.pi(posted);
  assert.deepEqual(open.told.map(t => t.key), ["kind-feature", "news-1114"]);
});

test("parked reads the label or the reaction", () => {
  assert.equal(parked(root()), false);
  assert.equal(parked(root({ labels: { todo: "yes" } })), true);
  assert.equal(parked(root({ reactions: { todo: ["x"] } })), true);
});
