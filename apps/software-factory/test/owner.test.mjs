import assert from "node:assert/strict";
import { test } from "node:test";
import { owner, threadOfBranch } from "../app/api/board/[[...path]]/owner.ts";

const root = (labels = { pr: "basehub-ai/vboard#89", state: "open" }) => ({ id: 1625, re: null, labels });
const source = {
  message: {
    id: 1559,
    by: { actor: "slack:user:U0AP7QRUM7E" },
    author: { handle: "martin", name: "Martin Sione" },
  },
};

function harness(pr) {
  const requests = [];
  const labels = [];
  const threads = [];
  const watcher = owner({
    token: async () => "test-token",
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return Response.json(pr);
    },
  });
  const board = {
    thread: async (id) => { threads.push(id); return source; },
    label: async (id, change) => { labels.push({ id, change }); },
  };
  return { requests, labels, threads, run: (event) => watcher.run({ event, board }) };
}

test("a factory PR's root is labeled with whoever opened its source thread", async () => {
  const h = harness({ head: { ref: "pi/1559-vercel-logs" } });
  await h.run({ type: "message.posted", message: root() });
  assert.equal(h.requests[0].url, "https://api.github.com/repos/basehub-ai/vboard/pulls/89");
  assert.equal(h.requests[0].headers.authorization, "Bearer test-token");
  assert.deepEqual(h.threads, [1559]);
  assert.deepEqual(h.labels, [{ id: 1625, change: { set: { owner: "slack:user:U0AP7QRUM7E", "owner.name": "Martin Sione" } } }]);
});

test("PRs from other branches, replies, and labeled roots are skipped", async () => {
  const h = harness({ head: { ref: "jb/some-branch" } });
  await h.run({ type: "message.posted", message: root() });
  assert.deepEqual(h.labels, []);
  await h.run({ type: "message.posted", message: { ...root(), re: 1600 } });
  await h.run({ type: "message.posted", message: root({ pr: "basehub-ai/vboard#89", owner: "slack:user:U1" }) });
  await h.run({ type: "labels.changed", message: root() });
  assert.equal(h.requests.length, 1);
});

test("threadOfBranch reads pi/<thread> branches only", () => {
  assert.equal(threadOfBranch("pi/1628"), 1628);
  assert.equal(threadOfBranch("pi/122-mentions"), 122);
  assert.equal(threadOfBranch("pi/slack-text-files"), null);
  assert.equal(threadOfBranch("main"), null);
  assert.equal(threadOfBranch(undefined), null);
});
