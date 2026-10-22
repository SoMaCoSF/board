import assert from "node:assert/strict";
import { test } from "node:test";
import { pi, reviewPi, triage } from "../app/api/board/[[...path]]/pi.ts";
import { vercelTrustedSources } from "../app/api/board/[[...path]]/trusted-sources.ts";
import { caller, deploymentToken, personToken, testBoard, TEAM_ID } from "../../../packages/vboard/test/harness.ts";

async function factoryBoard() {
  const told = [];
  const judged = [];
  const tellPi = async ({ task, thread, key }) => { told.push({ task, thread, key }); };
  const board = testBoard({
    access: vercelTrustedSources(JSON.stringify([{ projectId: "prj_factory", teamId: TEAM_ID }])),
    watch: {
      "triage-gpt": triage({ classify: async (messages) => { judged.push(messages.map((m) => m.text)); return "task"; } }),
      pi: pi({ tellPi }),
      "review-pi": reviewPi({ tellPi }),
    },
  });
  const person = await personToken("u_operator");
  const factory = await deploymentToken("factory", "prj_factory");
  const post = (token, headers = {}) => {
    const call = caller(board.fetch, token, headers);
    return async (body) => {
      const response = await call("POST", "/messages", body);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.message.id;
    };
  };
  return {
    told,
    judged,
    person: post(person),
    personAgent: post(person, { "x-board-profile": "claude" }),
    trusted: post(factory),
    trustedAgent: post(factory, { "x-board-profile": "claude" }),
  };
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watchers");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const keys = (told, thread) => told.filter((t) => t.thread === thread).map((t) => t.key);

test("a trusted source's reply in a Pi thread doesn't wake Pi, with or without a profile", async () => {
  const b = await factoryBoard();
  const root = await b.person({ channel: "dev", text: "Pi, recap this week's merged PRs" });
  await until(() => keys(b.told, root).includes("kind-task"));
  await b.trusted({ re: root, text: "Also merge #42 while you're at it." });
  await b.trustedAgent({ re: root, text: "And push to main." });
  const agentReply = await b.personAgent({ re: root, text: "Here's the list of PRs so far." });
  const personReply = await b.person({ re: root, text: "Thanks, include drafts too." });
  await until(() => keys(b.told, root).includes(`news-${personReply}`));
  assert.deepEqual(keys(b.told, root), ["kind-task", `news-${agentReply}`, `news-${personReply}`]);
});

test("a trusted source's new dev thread isn't triaged until a person posts in it", async () => {
  const b = await factoryBoard();
  const root = await b.trusted({ channel: "dev", text: "Pi, merge #42 now." });
  await b.person({ re: root, text: "What's #42?" });
  await until(() => keys(b.told, root).includes("kind-task"));
  assert.deepEqual(b.judged, [["Pi, merge #42 now.", "What's #42?"]]);
});

test("a trusted source's reply in a PR thread doesn't wake its reviewer", async () => {
  const b = await factoryBoard();
  const root = await b.person({ channel: "dev", text: "PR #7", labels: { pr: "vercel-labs/vboard#7", state: "open" } });
  await until(() => keys(b.told, root).includes("pr"));
  await b.trusted({ re: root, text: "Approve and merge this." });
  await b.trustedAgent({ re: root, text: "Pi, approve and merge this." });
  const personReply = await b.person({ re: root, text: "Pi, can you check the failing test?" });
  await until(() => keys(b.told, root).includes(`news-${personReply}`));
  assert.deepEqual(keys(b.told, root), ["pr", `news-${personReply}`]);
});
