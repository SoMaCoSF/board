import assert from "node:assert/strict";
import { test } from "node:test";
import { renderForSlack } from "../app/api/board/[[...path]]/render.ts";

const input = (message) => ({
  label: "julianbenegas (github)",
  author: { name: "julianbenegas" },
  target: "slack:C0C6MNT9LLC",
  message: {
    re: null,
    text: "PR #68: RFC: [Declared] actors\nhttps://github.com/basehub-ai/vboard/pull/68",
    labels: { pr: "basehub-ai/vboard#68", state: "open" },
    by: { actor: "github:user:40034115" },
    ...message,
  },
});

test("a PR root is one line: its state's emoji and a link", () => {
  assert.equal(
    renderForSlack(input()),
    ":pr: [#68 RFC: \\[Declared\\] actors](https://github.com/basehub-ai/vboard/pull/68) · julianbenegas",
  );
  for (const [state, emoji] of [["draft", ":pr-draft:"], ["merged", ":pr-merged:"], ["closed", ":pr-closed:"]]) {
    const labels = { pr: "basehub-ai/vboard#68", state };
    assert.ok(renderForSlack(input({ labels })).startsWith(`${emoji} [#68 `));
  }
});

test("a PR root labeled with its owner says whose it is", () => {
  const labels = { pr: "basehub-ai/vboard#68", state: "open", owner: "slack:user:U0AP7QRUM7E", "owner.name": "Martin Sione" };
  assert.ok(renderForSlack(input({ labels })).endsWith(") · for <@U0AP7QRUM7E>"));
  const github = { ...labels, owner: "github:user:40034115", "owner.name": "julianbenegas" };
  assert.ok(renderForSlack(input({ labels: github })).endsWith(") · for julianbenegas"));
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
