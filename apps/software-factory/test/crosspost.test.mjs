import assert from "node:assert/strict";
import { test } from "node:test";
import { crosspost } from "../app/api/board/[[...path]]/crosspost.ts";

const root = (labels = { pr: "vercel-labs/vboard#105", state: "open" }) => ({
  id: "2400",
  re: null,
  text: "PR #105: Link [PR] threads\nhttps://github.com/vercel-labs/vboard/pull/105",
  labels,
});
const SLACK = "https://vercel.enterprise.slack.com/archives/C0C6MNT9LLC";
const synced = (message = root(), target = "slack:C0C6MNT9LLC", url = `${SLACK}/p1791405000000100`) => ({
  type: "message.synced",
  payload: { id: message.id, target, external: { thread: `${target}:1791405000.000100`, message: "1791405000.000100", url } },
  message,
});
const slackSource = {
  id: "2326",
  from: "slack",
  origin: { thread: "slack:C0C6MNT9LLC:1791404203.820609", url: `${SLACK}/p1791404203820609` },
  author: { handle: "JB", name: "Julian Benegas" },
};

function harness({ ref = "pi/2326", source = slackSource } = {}) {
  const requests = [];
  const labels = [];
  const replies = [];
  const watcher = crosspost({
    token: async () => "test-token",
    fetch: async (url) => {
      requests.push(url);
      return Response.json({ head: { ref }, title: "Link [PR] threads" });
    },
  });
  const board = {
    thread: async () => ({ message: source }),
    label: async (id, change) => { labels.push({ id, change }); },
    reply: async (id, text) => { replies.push({ id, text }); },
  };
  return { requests, labels, replies, watcher, run: (event) => watcher.run({ event, board }) };
}

test("a factory PR's Slack thread and its source's Slack thread link to each other", async () => {
  const h = harness();
  await h.run(synced());
  assert.deepEqual(h.requests, ["https://api.github.com/repos/vercel-labs/vboard/pulls/105"]);
  assert.deepEqual(h.labels, [{ id: "2400", change: { set: { crosspost: "yes" } } }]);
  assert.deepEqual(h.replies, [
    {
      id: "2400",
      text: `:crosspost: From [Julian Benegas's Slack thread](${SLACK}/p1791404203820609) · board #2326`,
    },
    {
      id: "2326",
      text: `:crosspost: [#105 Link \\[PR\\] threads](${SLACK}/p1791405000000100)`,
    },
  ]);
});

test("skips posts, replies, GitHub receipts, receipts without a link, crossposted roots, other branches, and sources not from Slack", async () => {
  const h = harness();
  await h.run({ ...synced(), type: "message.posted" });
  await h.run(synced({ ...root(), re: "2399" }));
  await h.run(synced(root(), "github:vercel-labs/vboard", "https://github.com/vercel-labs/vboard/pull/105#issuecomment-1"));
  await h.run(synced(root(), "slack:C0C6MNT9LLC", null));
  await h.run(synced(root({ pr: "vercel-labs/vboard#105", crosspost: "yes" })));
  await h.run(synced(root({ pr: "vercel/v0#1" })));
  assert.equal(h.requests.length, 0);
  await h.run(synced());
  assert.equal(h.replies.length, 2, "the same harness links a Slack receipt for a factory PR");

  const other = harness({ ref: "jb/some-branch" });
  await other.run(synced());
  const github = harness({ source: { ...slackSource, from: "github", origin: { thread: "github:vercel-labs/vboard:issue:7", url: "https://github.com/vercel-labs/vboard/issues/7" } } });
  await github.run(synced());
  const unlinked = harness({ source: { ...slackSource, origin: { ...slackSource.origin, url: null } } });
  await unlinked.run(synced());
  assert.deepEqual([...other.replies, ...github.replies, ...unlinked.replies, ...other.labels, ...github.labels, ...unlinked.labels], []);
});
