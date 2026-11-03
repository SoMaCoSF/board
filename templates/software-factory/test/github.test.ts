import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutForks } from "../app/api/board/[[...path]]/github.ts";

// What each GitHub event does on the board, called as the board calls a repo's sync function: the
// channel it's imported into starts a thread there; none lands it only in a thread the board has.

type Fn = (sync: unknown) => Promise<void>;

const pr = (head: string | null, base = "acme/web") => ({
  pull_request: { number: 7, title: "Fix login", html_url: "https://github.com/acme/web/pull/7", head: { ref: "fix", repo: head === null ? null : { full_name: head } }, base: { ref: "main", repo: { full_name: base } } },
});
const issue = { issue: { number: 3, title: "Login is broken", html_url: "https://github.com/acme/web/issues/3" } };

async function imported(event: { type: string; raw: unknown }, direction: "in" | "out" = "in") {
  const into: (string | undefined)[] = [];
  const fn = withoutForks({ "acme/web": "dev" })["acme/web"] as Fn;
  await fn({ direction, channel: "acme/web:pulls", event, import: async (channel?: string) => void into.push(channel) });
  return into;
}

test("a PR from a branch of its own repo starts a thread in the repo's channel", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web") }), ["dev"]);
});

test("a fork's PR, and its reviews, start no thread", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("someone/web") }), [undefined]);
  assert.deepEqual(await imported({ type: "review.submitted", raw: pr("someone/web") }), [undefined]);
});

test("a PR whose fork is gone starts no thread", async () => {
  assert.deepEqual(await imported({ type: "pr.reopened", raw: pr(null) }), [undefined]);
});

test("an issue starts a thread in the repo's channel", async () => {
  assert.deepEqual(await imported({ type: "issue.opened", raw: issue }), ["dev"]);
});

test("a comment only lands in a thread the board already has", async () => {
  assert.deepEqual(await imported({ type: "comment", raw: issue }), [undefined]);
});

test("nothing goes back to GitHub", async () => {
  assert.deepEqual(await imported({ type: "pr.opened", raw: pr("acme/web") }, "out"), []);
});
