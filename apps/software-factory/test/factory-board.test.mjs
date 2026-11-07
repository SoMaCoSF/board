import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV } from "../app/api/board/[[...path]]/harness.ts";
import { personToken, testBoard as boardOf } from "../../../packages/board/test/harness.ts";
import { caller } from "../../../packages/board/test/tokens.ts";

const URL = "http://board.test/api/board";

/**
 * A board with the factory's sync and watchers, in memory: on Vercel's board the API keeps what this
 * one does, and what's the factory's is its channel, its rules, and its watchers.
 */
const testBoard = (given = {}) => boardOf({ url: URL, ...given });
const options = {};
const token = () => personToken("u_factory", URL);

test("PR-labeled Factory discussions stay off dev automation and external sync", async () => {
  const { autoland } = await import("../app/api/board/[[...path]]/autoland.ts");
  const { shipit } = await import("../app/api/board/[[...path]]/shipit.ts");
  const { security } = await import("../app/api/board/[[...path]]/security.ts");
  const { owner } = await import("../app/api/board/[[...path]]/owner.ts");
  const { inThread, devMirror } = await import("../app/api/board/[[...path]]/inthread.ts");
  const { fakePlatform } = await import("../../../packages/board/test/sync-fixtures.ts");
  const { channels, slack } = await import("@vercel/board/sync-slack");
  const { github, repos } = await import("@vercel/board/sync-github");
  const { issues, pulls } = await import("../app/api/board/[[...path]]/quiet.ts");
  const slackPlatform = fakePlatform("slack");
  const githubPlatform = fakePlatform("github");
  const watched = [];
  const noEve = async () => { throw new Error("must not start a live agent"); };
  const watchers = { autoland: autoland(), shipit: shipit({ tellEve: noEve }), security: security({ tellEve: noEve }), owner: owner(), "in-thread": inThread() };
  const board = testBoard({
    ...options,
    sync: {
      slack: slack({ adapter: slackPlatform.adapter }, channels({ C1: DEV })),
      github: github({ adapter: githubPlatform.adapter }, repos({ "vercel-labs/board": { pulls, issues } })),
    },
    watch: Object.fromEntries(Object.entries(watchers).map(([name, watcher]) => [name, {
      ...watcher, run: ({ event }) => { watched.push([name, event.message?.channel]); },
    }])),
  });
  const operator = caller(board.fetch, await personToken("u_operator", URL));
  const factory = caller(board.fetch, await token());
  const labels = { pr: "vercel-labs/board#123", kind: "bug" };
  const posted = await factory("POST", "/messages", { channel: "factory/project/repo/ci-health", text: "Review evidence", labels, noSync: true });
  assert.equal(posted.status, 201);
  await operator("POST", `/messages/${posted.body.message.id}/reactions`, { emoji: "shipit" });
  // Test channel routing independently of the Factory's noSync safeguard too.
  await operator("POST", "/messages", { channel: "factory/project/repo/ci-health", text: "Internal evidence", labels });
  await operator("POST", "/messages", { channel: DEV, text: "Existing dev behavior", labels });
  const deadline = Date.now() + 5000;
  while ((new Set(watched.map(([name]) => name)).size !== 5 || slackPlatform.channelPosts.length !== 1) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(new Set(watched.map(([name]) => name)).size, 5);
  assert.ok(watched.every(([, channel]) => channel === DEV));
  assert.equal(slackPlatform.channelPosts.length, 1);
  assert.equal(githubPlatform.channelPosts.length, 0);
  assert.equal(githubPlatform.posts.length, 0);
  assert.match(slackPlatform.channelPosts[0].text, /Existing dev behavior/);
  await board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "existing-dev-pr" },
    body: JSON.stringify({ action: "opened", repository: { full_name: "vercel-labs/board" }, sender: { login: "reviewer", id: 42 },
      pull_request: { number: 123, title: "Existing GitHub work", html_url: "https://github.com/vercel-labs/board/pull/123", draft: false, merged: false } }),
  }));
  let githubRoot;
  const until = Date.now() + 5000;
  while (!githubRoot && Date.now() < until) {
    githubRoot = (await operator("GET", `/messages?channel=${encodeURIComponent(DEV)}&text=Existing%20GitHub%20work`)).body.messages[0];
    if (!githubRoot) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(githubRoot);
  // A board reply in a PR's thread (an Eve's, say) reaches Slack but not the PR on GitHub.
  const slackBefore = slackPlatform.posts.length;
  await operator("POST", "/messages", { re: githubRoot.re ?? githubRoot.id, text: "Existing dev response" });
  while (slackPlatform.posts.length === slackBefore && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slackPlatform.posts.slice(slackBefore).some((post) => /Existing dev response/.test(post.text)));
  assert.equal(githubPlatform.posts.length, 0);
  // So does one in an issue's thread.
  await board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST", headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "existing-dev-issue" },
    body: JSON.stringify({ action: "opened", repository: { full_name: "vercel-labs/board" }, sender: { login: "reporter", id: 43 },
      issue: { number: 124, title: "Existing GitHub issue", html_url: "https://github.com/vercel-labs/board/issues/124" } }),
  }));
  let issueRoot;
  while (!issueRoot && Date.now() < until) {
    issueRoot = (await operator("GET", `/messages?channel=${encodeURIComponent(DEV)}&text=Existing%20GitHub%20issue`)).body.messages[0];
    if (!issueRoot) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(issueRoot);
  const slackBeforeIssue = slackPlatform.posts.length;
  await operator("POST", "/messages", { re: issueRoot.re ?? issueRoot.id, text: "Existing issue response" });
  while (slackPlatform.posts.length === slackBeforeIssue && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slackPlatform.posts.slice(slackBeforeIssue).some((post) => /Existing issue response/.test(post.text)));
  assert.equal(githubPlatform.posts.length, 0);
});

test("a factory PR starts its own Slack thread, and the thread it was built for gets its line", async () => {
  const { inThread, devMirror } = await import("../app/api/board/[[...path]]/inthread.ts");
  const { renderForSlack } = await import("../app/api/board/[[...path]]/render.ts");
  const { fakePlatform } = await import("../../../packages/board/test/sync-fixtures.ts");
  const { channels, slack } = await import("@vercel/board/sync-slack");
  const { render } = await import("@vercel/board/sync");
  const { github, repos } = await import("@vercel/board/sync-github");
  const { issues, pulls } = await import("../app/api/board/[[...path]]/quiet.ts");
  const slackPlatform = fakePlatform("slack");
  const githubPlatform = fakePlatform("github");
  const board = testBoard({
    ...options,
    sync: {
      slack: slack({ adapter: slackPlatform.adapter }, render(renderForSlack, channels({ C1: devMirror(DEV) }))),
      github: github({ adapter: githubPlatform.adapter }, repos({ "vercel-labs/board": { pulls, issues } })),
    },
    watch: { "in-thread": inThread() },
  });
  const operator = caller(board.fetch, await personToken("u_operator", URL));
  const until = Date.now() + 5000;
  const waitFor = async (check) => {
    let value;
    while (!(value = await check()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(value);
    return value;
  };
  const source = (await operator("POST", "/messages", { channel: DEV, text: "Post PRs in the thread" })).body.message;
  await waitFor(() => slackPlatform.channelPosts.length === 1);
  const pr = (action, extra = {}) => board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": `in-thread-${action}` },
    body: JSON.stringify({
      action, repository: { full_name: "vercel-labs/board" }, sender: { login: "factory[bot]", id: 9 },
      pull_request: {
        number: 77, title: "Post PRs in their thread", html_url: "https://github.com/vercel-labs/board/pull/77", draft: false, merged: false,
        head: { ref: `board/${source.id}`, repo: { full_name: "vercel-labs/board" } }, ...extra,
      },
    }),
  }));
  await pr("opened");
  const root = await waitFor(async () => {
    const found = (await operator("GET", `/messages?channel=${encodeURIComponent(DEV)}&label=pr`)).body.messages.find((m) => m.re === null && m.labels.card);
    return found;
  });
  assert.equal(root.labels.source, source.id);
  const card = await waitFor(() => slackPlatform.posts.find((post) => post.text.includes("#77") && post.threadId?.endsWith(slackPlatform.channelPosts[0].id)));
  assert.equal(JSON.parse(card.text).markdown, ":pr: [#77 Post PRs in their thread](https://github.com/vercel-labs/board/pull/77)");
  assert.ok(card.threadId.endsWith(slackPlatform.channelPosts[0].id), "in the source's Slack thread");
  await waitFor(() => slackPlatform.channelPosts.length === 2);
  assert.match(slackPlatform.channelPosts[1].text, /#77 Post PRs in their thread/, "the PR starts its own thread in the channel");

  await pr("closed", { merged: true });
  await waitFor(() => slackPlatform.edits.some((edit) => String(edit.text ?? JSON.stringify(edit)).includes(":pr-merged: [#77")));
  assert.equal(slackPlatform.channelPosts.length, 2);
  assert.deepEqual(slackPlatform.reactions.filter((r) => r.emoji.startsWith("pr")), [], "no PR emoji on the source root");

  // A source thread kept off Slack gets no line, and its PR still starts its own thread.
  const hidden = (await operator("POST", "/messages", { channel: DEV, text: "Board-only thread", noSync: true })).body.message;
  await board.fetch(new Request(`${URL}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "in-thread-hidden" },
    body: JSON.stringify({
      action: "opened", repository: { full_name: "vercel-labs/board" }, sender: { login: "factory[bot]", id: 9 },
      pull_request: {
        number: 78, title: "From a board-only thread", html_url: "https://github.com/vercel-labs/board/pull/78", draft: false, merged: false,
        head: { ref: `board/${hidden.id}`, repo: { full_name: "vercel-labs/board" } },
      },
    }),
  }));
  await waitFor(() => slackPlatform.channelPosts.length === 3);
  assert.match(slackPlatform.channelPosts[2].text, /#78 From a board-only thread/);
});
