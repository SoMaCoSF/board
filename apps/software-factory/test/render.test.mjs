import assert from "node:assert/strict";
import { test } from "node:test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { renderForSlack } from "../app/api/board/[[...path]]/render.ts";

const input = (message, extra = {}) => ({
  label: "julianbenegas (github)",
  author: { name: "julianbenegas" },
  mentionOf: (actor) => (actor === "slack:user:U0AP7QRUM7E" ? "<@U0AP7QRUM7E>" : null),
  target: "slack:C0C6MNT9LLC",
  ...extra,
  message: {
    re: null,
    text: "PR #68: RFC: [Declared] actors\nhttps://github.com/vercel-labs/vboard/pull/68",
    labels: { pr: "vercel-labs/vboard#68", state: "open" },
    by: { actor: "github:user:40034115" },
    ...message,
  },
});

test("a PR root is one line: its state's emoji and a link", () => {
  assert.equal(
    renderForSlack(input()),
    ":pr: [#68 RFC: \\[Declared\\] actors](https://github.com/vercel-labs/vboard/pull/68) · julianbenegas",
  );
  for (const [state, emoji] of [["draft", ":pr-draft:"], ["merged", ":pr-merged:"], ["closed", ":pr-closed:"]]) {
    const labels = { pr: "vercel-labs/vboard#68", state };
    assert.ok(renderForSlack(input({ labels })).startsWith(`${emoji} [#68 `));
  }
});

test("a PR's title can't add links or HTML to its root", () => {
  const text = String.raw`PR #68: Fix \](https://evil.example/login) <a href="https://evil.example">x</a> [x` + "\nhttps://github.com/vercel-labs/vboard/pull/68";
  const found = [];
  visit(unified().use(remarkParse).use(remarkGfm).parse(renderForSlack(input({ text }))), ["link", "html"], (node) => {
    found.push(node.type === "link" ? node.url : node.value);
  });
  assert.deepEqual(found, ["https://github.com/vercel-labs/vboard/pull/68"]);
});

test("a PR root labeled with its owner says whose it is", () => {
  const labels = { pr: "vercel-labs/vboard#68", state: "open", owner: "slack:user:U0AP7QRUM7E", "owner.name": "Martin Sione" };
  assert.ok(renderForSlack(input({ labels })).endsWith(") · for <@U0AP7QRUM7E>"));
  const github = { ...labels, owner: "github:user:40034115", "owner.name": "julianbenegas" };
  assert.ok(renderForSlack(input({ labels: github })).endsWith(") · for julianbenegas"));
});

test("a PR root mentions its author where Slack can", () => {
  const martin = input({ by: { actor: "slack:user:U0AP7QRUM7E" } }, { author: { name: "martinsione" } });
  assert.ok(renderForSlack(martin).endsWith(") · <@U0AP7QRUM7E>"));
  // Replies keep the default label.
  assert.equal(renderForSlack({ ...martin, message: { ...martin.message, re: 68, text: "fixed" } }), "**julianbenegas (github)**: fixed");
});

test("everything else keeps the default", () => {
  assert.equal(renderForSlack(input({ re: 68, text: "looks good" })), "**julianbenegas (github)**: looks good");
  const issue = input({ text: "Issue #6: Link identities\nhttps://github.com/x", labels: { issue: "x#6", state: "open" } });
  assert.equal(renderForSlack(issue), `**julianbenegas (github)**: ${issue.message.text}`);
});

test("crosspost links go without a label", () => {
  const text = ":crosspost: [#105 Link threads](https://vercel.slack.com/archives/C0C6MNT9LLC/p1791405000000100)";
  const message = { re: 2326, text, labels: {}, by: { actor: "vboard:watch:crosspost" } };
  assert.equal(renderForSlack({ ...input(message), label: "crosspost" }), text);
});
