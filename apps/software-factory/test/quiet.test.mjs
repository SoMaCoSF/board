import assert from "node:assert/strict";
import { test } from "node:test";
import { boardOnly, syncPull } from "../app/api/board/[[...path]]/quiet.ts";
import { BOARD_URL, caller, personToken, testBoard } from "../../../packages/vboard/test/harness.ts";
import { fakePlatform } from "../../../packages/vboard/test/sync-fixtures.ts";
import { github } from "../../../packages/vboard/src/sync/github.ts";

const lifecycle = (type, labels = {}) => ({ subthread: null, type, labels });

test("a PR closed without merging stays off Slack", () => {
  assert.equal(boardOnly(lifecycle("pr.closed", { state: "closed" })), true);
});

test("merges, reopens and other PR events still reach Slack", () => {
  assert.equal(boardOnly(lifecycle("pr.closed", { state: "merged" })), false);
  assert.equal(boardOnly(lifecycle("pr.reopened", { state: "open" })), false);
  assert.equal(boardOnly(lifecycle("review.submitted", { review: "approved" })), false);
  assert.equal(boardOnly({ subthread: null, type: "comment" }), false);
});

test("inline review comments stay off Slack", () => {
  assert.equal(boardOnly({ subthread: "github:vercel-labs/vboard:40:rc:9", type: "comment" }), true);
});

test("PR comments land only in threads the board has, which start when a PR opens", async () => {
  const lookups = [];
  const octokit = { rest: { pulls: { get: async (args) => { lookups.push(args); throw new Error("no root lookups"); } } } };
  const platform = fakePlatform("github", (adapter) => Object.assign(adapter, { octokit }));
  let handled = 0;
  const run = async (args) => { await syncPull(args); handled++; };
  const board = testBoard({ sync: { github: github({ adapter: platform.adapter, repos: { "vercel-labs/vboard": { pulls: { channel: "dev", run } } } }) } });
  const operator = caller(board.fetch, await personToken());
  const send = async (body, headers = {}) => {
    const before = handled;
    await board.fetch(new Request(`${BOARD_URL}/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const deadline = Date.now() + 5000;
    while (handled === before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handled, before + 1);
  };
  const comment = (id, threadId = "github:vercel-labs/vboard:114") => send({ type: "message", threadId, id, text: `comment ${id}`, user: "42" });
  const dev = async () => (await operator("GET", "/messages?channel=dev")).body.messages;

  await comment("c1");
  await comment("c2", "github:vercel-labs/vboard:114:rc:9");
  assert.deepEqual(await dev(), []);

  await send({
    action: "opened", repository: { full_name: "vercel-labs/vboard" }, sender: { login: "ada", id: 42 },
    pull_request: { number: 114, title: "Seen", html_url: "https://github.com/vercel-labs/vboard/pull/114", draft: false, merged: false },
  }, { "x-github-event": "pull_request", "x-github-delivery": "opened-114" });
  await comment("c3");
  await comment("c4", "github:vercel-labs/vboard:114:rc:9");
  const [root, top, inline, ...rest] = await dev();
  assert.equal(root.labels.pr, "vercel-labs/vboard#114");
  assert.equal(root.noSync, false);
  assert.deepEqual([top.text, top.re, top.noSync], ["comment c3", root.id, false]);
  assert.deepEqual([inline.text, inline.re, inline.noSync], ["comment c4", root.id, true]);
  assert.deepEqual(rest, []);
  assert.deepEqual(lookups, []);
});
