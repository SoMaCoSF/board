import assert from "node:assert/strict";
import { test } from "node:test";
import { githubScope, threadRepos } from "../lib/github.ts";

// What a thread's GitHub token covers: what agent/lib/credentials.ts asks Vercel Connect for each turn.

const REPOS = ["acme/factory", "acme/web", "other/api"];

test("a thread from a GitHub PR or issue gets its own repo alone", () => {
  assert.deepEqual(threadRepos({ labels: { pr: "acme/web#7", state: "open" } }, REPOS), ["acme/web"]);
  assert.deepEqual(threadRepos({ labels: { issue: "acme/factory#3" } }, REPOS), ["acme/factory"]);
});

test("any other thread gets the repos the board brings in, not every repo the app is on", () => {
  assert.deepEqual(threadRepos({ labels: {} }, REPOS), ["acme/factory", "acme/web", "other/api"]);
});

test("Connect is asked for one org's repos, by name: the first repo's org", () => {
  assert.deepEqual(githubScope(["acme/factory", "acme/web", "other/api"]), [{ type: "github_app_installation", org: "acme", repositories: ["factory", "web"] }]);
});

test("no repos, no token", () => {
  assert.equal(githubScope([]), null);
});
