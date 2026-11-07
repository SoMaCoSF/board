import assert from "node:assert/strict";
import { test } from "node:test";
import { byAgent, byEve, byWatcher, eveAvatar, eveName, sourceLink, startOrSay, taskMessage } from "../app/api/board/[[...path]]/agent.ts";

// Eve posts as the factory's production deployment.
process.env.VERCEL_PROJECT_ID = "prj_factory";

test("sourceLink: a Slack thread's permalink, a GitHub issue or PR, or nothing", () => {
  assert.deepEqual(sourceLink({ thread: "slack:C0C6MNT9LLC:1791394851.272189" }), {
    platform: "Slack",
    url: "https://vercel.slack.com/archives/C0C6MNT9LLC/p1791394851272189",
  });
  assert.deepEqual(sourceLink({ thread: "github:vercel-labs/board:issue:42" }), {
    platform: "GitHub",
    url: "https://github.com/vercel-labs/board/issues/42",
  });
  assert.deepEqual(sourceLink({ thread: "github:vercel-labs/board:78" }), {
    platform: "GitHub",
    url: "https://github.com/vercel-labs/board/pull/78",
  });
  assert.equal(sourceLink(null), null);
  assert.equal(sourceLink({ thread: "whatsapp:123" }), null);
});

test("taskMessage: Eve's task names where the thread came from and who posted it", () => {
  assert.equal(
    taskMessage("a feature request", {
      id: "1010",
      origin: { thread: "slack:C0C6MNT9LLC:1791394851.272189" },
      author: { name: "Martin Sione" },
    }),
    "There's a feature request in board thread #1010, posted by Martin Sione on Slack: https://vercel.slack.com/archives/C0C6MNT9LLC/p1791394851272189.",
  );
  assert.equal(
    taskMessage("a bug report", { id: "7", origin: null, author: null }),
    "There's a bug report in board thread #7.",
  );
});

test("eveName: each thread's Eve has a name of its own", () => {
  assert.equal(eveName("1956"), "clever-lemur-1956");
  const names = new Set();
  for (let t = 1; t <= 100_000; t++) {
    const name = eveName(t);
    // A valid board profile: starts with a letter, up to 32 letters, numbers, and hyphens.
    if (t % 997 === 0) assert.match(name, /^[A-Za-z][A-Za-z0-9-]{0,31}$/);
    names.add(name);
  }
  assert.equal(names.size, 100_000);
  assert.ok(eveName("99999999").length <= 32);
});

test("eveName: a thread on Vercel's board is named by its key's first 8 characters, as a profile fits", () => {
  const root = "msg_3f2a9c1d-0b4e-4c5a-9d7e-1a2b3c4d5e6f_1";
  assert.match(eveName(root), /^[a-z]+-[a-z]+-3f2a9c1d$/);
  assert.match(eveName(root), /^[A-Za-z][A-Za-z0-9-]{0,31}$/);
  assert.notEqual(eveName(root), eveName("msg_3f2a9c1e-0b4e-4c5a-9d7e-1a2b3c4d5e6f_1"));
});

test("byEve: the thread's own Eve, by its name, and no other thread's", () => {
  const session = "thread-1956";
  const principal = "vercel:project:prj_factory:production";
  assert.ok(byEve("1956", { principal, profile: eveName("1956"), session }));
  // `pi`, Eve's name before it had one of its own, was the old board's: a watcher has it on Vercel's.
  assert.ok(!byEve("1956", { principal, profile: "pi", session }));
  assert.ok(!byEve("1956", { principal, profile: eveName("1957"), session }));
  assert.ok(!byEve("1956", { principal, profile: eveName("1956"), session: "thread-1957" }));
  assert.ok(!byEve("1956", { principal, profile: null, session: null }));
});

test("byEve: only the factory's production deployment, since anyone who can write sends a profile and session", () => {
  const pi = { profile: eveName("1956"), session: "thread-1956" };
  for (const principal of [
    "vercel:user:abc123",
    "vercel:project:prj_factory:preview",
    "vercel:project:prj_other:production",
    "github:repo:1",
    "slack:user:U1",
  ]) {
    assert.ok(!byEve("1956", { principal, ...pi }), principal);
  }
  delete process.env.VERCEL_PROJECT_ID;
  try {
    assert.ok(!byEve("1956", { principal: "vercel:project:undefined:production", ...pi }), "no project, no Eve");
  } finally {
    process.env.VERCEL_PROJECT_ID = "prj_factory";
  }
});

test("byEve: on the previews' board, a preview's Eve, and still never production's there or a preview's on production's", () => {
  const eve = { profile: eveName("1956"), session: "thread-1956" };
  const preview = "vercel:project:prj_factory:preview";
  const production = "vercel:project:prj_factory:production";
  const env = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = "preview";
    assert.ok(byEve("1956", { principal: preview, ...eve }));
    assert.ok(!byEve("1956", { principal: production, ...eve }));
    process.env.VERCEL_ENV = "production";
    assert.ok(!byEve("1956", { principal: preview, ...eve }));
    assert.ok(byEve("1956", { principal: production, ...eve }));
  } finally {
    if (env === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = env;
  }
});

test("eveAvatar: a PNG generated from each Eve's name", () => {
  assert.equal(eveAvatar("1956"), "https://vercel.com/api/www/avatar?s=64&format=png&u=clever-lemur-1956");
});

test("byWatcher: the board's watchers' own notes, which wake neither Eve nor triage", () => {
  const none = { principal: "board:watch", session: null };
  assert.ok(byWatcher({ actor: "board:watch:crosspost", ...none }));
  assert.ok(byWatcher({ actor: "board:watch:security", ...none }));
  assert.ok(byWatcher({ actor: "board:watch:pi", ...none }));
  assert.ok(!byWatcher({ actor: "slack:user:U123", principal: "slack:user:U123", session: null }));
  assert.ok(!byWatcher({ actor: "board:schedule", principal: "board:schedule", session: null }));
  // On Vercel's board: the factory's project under a watcher's ID, with no session, which every Eve has.
  const factory = "vercel:project:prj_factory:production";
  assert.ok(byWatcher({ actor: `${factory}+pi`, principal: factory, session: null }));
  assert.ok(byWatcher({ actor: `${factory}+in-thread`, principal: factory, session: null }));
  assert.ok(!byWatcher({ actor: `${factory}+${eveName("1956")}`, principal: factory, session: "thread-1956" }));
  const other = "vercel:project:prj_other:production";
  assert.ok(!byWatcher({ actor: `${other}+pi`, principal: other, session: null }));
});

test("byAgent: a coding agent's or Eve's message, which triage doesn't judge, and not a person's", () => {
  assert.ok(byAgent({ profile: "claude" }));
  assert.ok(byAgent({ profile: eveName("1956") }));
  assert.ok(!byAgent({ profile: null }));
});

function thread() {
  const replies = [];
  return { replies, board: { reply: async (id, text) => { replies.push({ id, text }); } } };
}

test("startOrSay: a start that fails is tried again, and once Eve starts the thread hears nothing", async () => {
  const { replies, board } = thread();
  let tries = 0;
  await startOrSay(board, 7, async () => {
    if (++tries < 3) throw new Error("sandbox setup failed: ");
  }, 0);
  assert.equal(tries, 3);
  assert.deepEqual(replies, []);
});

test("startOrSay: an Eve that never starts says why in its thread instead of throwing, so its watcher keeps listening", async () => {
  const { replies, board } = thread();
  let tries = 0;
  const error = console.error;
  console.error = () => {};
  try {
    await startOrSay(board, 2903, async () => {
      tries++;
      throw new Error("sandbox setup failed: curl: (22) The requested URL returned error: 403\ncurl: (22) The requested URL returned error: 404");
    }, 0);
  } finally {
    console.error = error;
  }
  assert.ok(tries > 1, "it was retried first");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 2903);
  assert.match(replies[0].text, /couldn't start/);
  assert.match(replies[0].text, /returned error: 403/);
  assert.match(replies[0].text, /try again/);
});

test("the reviewer tells the PR's source thread, and that thread's Eve acts on it", async () => {
  const { INSTRUCTIONS } = await import("../app/api/board/[[...path]]/agent.ts");
  assert.match(INSTRUCTIONS.review, /Tell the thread the work started in/);
  assert.match(INSTRUCTIONS.thread, /Your PR's reviewer posts its verdict in your thread/);
  assert.match(INSTRUCTIONS.thread, /gets the reviewer to look again/);
});

test("Eve's branch for a thread is board/<its key>, which names its thread back", async () => {
  const { INSTRUCTIONS } = await import("../app/api/board/[[...path]]/agent.ts");
  const { eveBranch } = await import("../app/api/board/[[...path]]/harness.ts");
  const { threadOfBranch } = await import("../app/api/board/[[...path]]/owner.ts");
  const root = "msg_3f2a9c1d-0b4e-4c5a-9d7e-1a2b3c4d5e6f_1";
  assert.equal(eveBranch(root), "board/3f2a9c1d-0b4e-4c5a-9d7e-1a2b3c4d5e6f");
  assert.equal(threadOfBranch(eveBranch(root)), root);
  assert.equal(threadOfBranch(`${eveBranch(root)}-vercel-logs`), root);
  assert.equal(eveBranch("1559"), "board/1559");
  assert.equal(threadOfBranch(eveBranch("1559")), "1559");
  assert.match(INSTRUCTIONS.thread, /goes on your thread's branch \(never main\)/);
  assert.match(INSTRUCTIONS.review, /its branch is board\/<key>/);
  for (const text of Object.values(INSTRUCTIONS)) assert.doesNotMatch(text, /\b(?:pi|factory)\/</);
});
