import assert from "node:assert/strict";
import { test } from "node:test";
import { inviteToPreviewChannel, ownThreads, previewBot, previewLog, slackConnector } from "../app/api/board/[[...path]]/preview.ts";

test("a branch's bot is named for it, short enough for Slack", () => {
  assert.deepEqual(previewBot("martin/preview-bots"), {
    connector: "slack/vboard-preview-martin-preview-bots",
    appName: "vboard martin-preview-bots",
  });
  const long = previewBot("pi/2588-typing-takes-an-optional-status");
  assert.ok(long.appName.length <= 35, long.appName);
  assert.match(long.connector, /^slack\/vboard-preview-pi-2588-typing-tak-[0-9a-f]{5}$/);
  assert.notEqual(long.connector, previewBot("pi/2588-typing-takes-an-optional-statuz").connector);
});

test("a preview speaks as its branch's bot and keeps its branch's log; the rest as production", () => {
  const preview = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "pi/12" };
  assert.equal(slackConnector(preview), "slack/vboard-preview-pi-12");
  assert.equal(previewLog(preview), "preview:pi-12");
  assert.equal(slackConnector({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }), "slack/vboard-factory");
  assert.equal(slackConnector({}), "slack/vboard-factory");
  assert.equal(previewLog({ VERCEL_ENV: "development" }), "development");
});

const BOT = "U0PREVIEW";

function harness(roots) {
  const asked = [];
  const synced = [];
  const web = async () => ({
    auth: { test: async () => ({ user_id: BOT, bot_id: "B0PREVIEW" }) },
    conversations: {
      replies: async ({ ts }) => {
        asked.push(ts);
        return { messages: roots[ts] ? [roots[ts]] : [] };
      },
    },
  });
  const run = ownThreads(web);
  const board = { sync: async (channel, event) => synced.push([channel, event.message]) };
  return { asked, synced, deliver: (event) => run({ event, board }) };
}

const message = (ts, message, raw = {}) => ({
  kind: "message",
  thread: `slack:C0C7P6NN8FM:${ts}`,
  message,
  isRoot: ts === message,
  raw,
});

test("a preview takes a root that mentions its bot, and that thread's replies", async () => {
  const roots = { "1.1": { user: "U0PERSON", text: `<@${BOT}> try this` } };
  const { synced, asked, deliver } = harness(roots);
  await deliver(message("1.1", "1.1", roots["1.1"]));
  await deliver(message("1.1", "1.2"));
  assert.deepEqual(synced, [["dev", "1.1"], ["dev", "1.2"]]);
  assert.deepEqual(asked, [], "the root's verdict is kept for its replies");
});

test("a preview takes replies in a thread its bot started", async () => {
  const { synced, deliver } = harness({ "2.1": { user: BOT, text: "a watcher's post" } });
  await deliver(message("2.1", "2.5"));
  await deliver({ kind: "reaction", thread: "slack:C0C7P6NN8FM:2.1", message: "2.1", emoji: "eyes" });
  assert.deepEqual(synced, [["dev", "2.5"], ["dev", "2.1"]]);
});

test("a root the board posted under an author's name, with only the bot's ID, is the preview's", async () => {
  const { synced, deliver } = harness({ "6.1": { bot_id: "B0PREVIEW", text: "e2e: a board post" } });
  await deliver(message("6.1", "6.2"));
  assert.deepEqual(synced, [["dev", "6.2"]]);
});

test("another preview's thread, or nobody's, is left alone", async () => {
  const roots = { "3.1": { user: "U0PERSON", text: "<@U0OTHER> hi" }, "4.1": { user: "U0OTHER", text: "mine" } };
  const { synced, deliver } = harness(roots);
  await deliver(message("3.1", "3.1", roots["3.1"]));
  await deliver(message("3.1", "3.2"));
  await deliver(message("4.1", "4.2"));
  assert.deepEqual(synced, []);
});

test("a failed lookup is asked again", async () => {
  let fail = true;
  const synced = [];
  const run = ownThreads(async () => ({
    auth: { test: async () => ({ user_id: BOT }) },
    conversations: {
      replies: async () => {
        if (fail) throw new Error("ratelimited");
        return { messages: [{ user: BOT }] };
      },
    },
  }));
  const board = { sync: async (_channel, event) => synced.push(event.message) };
  await assert.rejects(run({ event: message("5.1", "5.2"), board }));
  fail = false;
  await run({ event: message("5.1", "5.2"), board });
  assert.deepEqual(synced, ["5.2"]);
});

test("the inviter adds the preview's bot and the tester to the preview channel, once or again", async () => {
  const calls = [];
  const slack = (answers) => async (token, method, body) => {
    calls.push([token, method, body]);
    return typeof answers[method] === "function" ? answers[method](token) : answers[method];
  };
  await inviteToPreviewChannel(["xoxb-preview", "xoxb-tester"], "xoxb-inviter", slack({
    "auth.test": (token) => ({ ok: true, user_id: token === "xoxb-tester" ? "U0TESTER" : BOT }),
    "conversations.invite": { ok: false, error: "already_in_channel" },
  }));
  assert.deepEqual(calls, [
    ["xoxb-preview", "auth.test", {}],
    ["xoxb-inviter", "conversations.invite", { channel: "C0C7P6NN8FM", users: BOT }],
    ["xoxb-tester", "auth.test", {}],
    ["xoxb-inviter", "conversations.invite", { channel: "C0C7P6NN8FM", users: "U0TESTER" }],
  ]);
  await assert.rejects(
    inviteToPreviewChannel(["xoxb-preview"], "xoxb-inviter", slack({
      "auth.test": { ok: true, user_id: BOT },
      "conversations.invite": { ok: false, error: "not_in_channel" },
    })),
    /conversations.invite: not_in_channel/,
  );
});
