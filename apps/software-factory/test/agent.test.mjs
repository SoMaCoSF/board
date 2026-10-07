import assert from "node:assert/strict";
import { test } from "node:test";
import { GITHUB_TOKEN, INSTRUCTIONS, byPi, newsMessage, piAvatar, piName, quote, sincePi, sourceLink, taskMessage } from "../app/api/board/[[...path]]/agent.ts";

for (const task of ["thread", "review"]) {
  test(`${task}: Pi stays out of messages meant for someone else`, () => {
    assert.match(INSTRUCTIONS[task], /addressed to someone else/);
    assert.match(INSTRUCTIONS[task], /don't reply/i);
  });

  test(`${task}: board replies are tight, with no "what I ran" list`, () => {
    assert.doesNotMatch(INSTRUCTIONS[task], /list of what you ran/);
    assert.match(INSTRUCTIONS[task], /no "What I ran"/i);
    assert.match(INSTRUCTIONS[task], /a few lines/);
  });
}

test("review: detail goes in GitHub review comments, not the board", () => {
  assert.match(INSTRUCTIONS.review, /gh api .*pulls\/<N>\/reviews/);
  assert.match(INSTRUCTIONS.review, /file:line/);
});

test("review: COMMENT on the factory's own PRs, which GitHub won't let it approve or block", () => {
  assert.match(INSTRUCTIONS.review, /--input/);
  assert.match(INSTRUCTIONS.review, /own PRs, so on a PR it opened use COMMENT/);
  assert.match(INSTRUCTIONS.review, /lines the diff touches/);
});

test("thread: the PR body opens with what triggered it", () => {
  assert.match(INSTRUCTIONS.thread, /Open the PR body with one line saying what triggered it/);
  assert.match(INSTRUCTIONS.thread, /Slack thread\]\(<link>\) · board #<id>/);
  assert.match(INSTRUCTIONS.thread, /Closes #<issue>/);
});

test("sourceLink: a Slack thread's permalink, a GitHub issue or PR, or nothing", () => {
  assert.deepEqual(sourceLink({ thread: "slack:C0C6MNT9LLC:1791394851.272189" }), {
    platform: "Slack",
    url: "https://vercel.slack.com/archives/C0C6MNT9LLC/p1791394851272189",
  });
  assert.deepEqual(sourceLink({ thread: "github:basehub-ai/vboard:issue:42" }), {
    platform: "GitHub",
    url: "https://github.com/basehub-ai/vboard/issues/42",
  });
  assert.deepEqual(sourceLink({ thread: "github:basehub-ai/vboard:78" }), {
    platform: "GitHub",
    url: "https://github.com/basehub-ai/vboard/pull/78",
  });
  assert.equal(sourceLink(null), null);
  assert.equal(sourceLink({ thread: "whatsapp:123" }), null);
});

test("taskMessage: Pi's task names where the thread came from and who posted it", () => {
  assert.equal(
    taskMessage("a feature request", {
      id: 1010,
      origin: { thread: "slack:C0C6MNT9LLC:1791394851.272189" },
      author: { name: "Martin Sione" },
    }),
    "There's a feature request in board thread #1010, posted by Martin Sione on Slack: https://vercel.slack.com/archives/C0C6MNT9LLC/p1791394851272189.",
  );
  assert.equal(
    taskMessage("a bug report", { id: 7, origin: null, author: null }),
    "There's a bug report in board thread #7.",
  );
});

for (const task of ["thread", "review"]) {
  test(`${task}: Pi doesn't restate what the thread already shows, GitHub included`, () => {
    assert.match(INSTRUCTIONS[task], /no recaps of the thread, including messages synced from GitHub/);
    assert.match(INSTRUCTIONS[task], /say each thing once/);
  });
}

test("review: the review reaches the board on its own, so the board reply doesn't restate it", () => {
  assert.match(INSTRUCTIONS.review, /shows up in the board thread .* on its own/);
  assert.doesNotMatch(INSTRUCTIONS.review, /Then reply in the board thread with just the verdict/);
  assert.match(INSTRUCTIONS.review, /keep the body short/i);
  assert.match(INSTRUCTIONS.review, /Always put the verdict in the body/);
});

test("piName: each thread's Pi has a name of its own, the same every time", () => {
  assert.equal(piName(1956), piName(1956));
  assert.match(piName(1956), /^[a-z]+-[a-z]+-1956$/);
  const names = new Set();
  for (let t = 1; t <= 100_000; t++) {
    const name = piName(t);
    // A valid board profile: starts with a letter, up to 32 letters, numbers, and hyphens.
    if (t % 997 === 0) assert.match(name, /^[A-Za-z][A-Za-z0-9-]{0,31}$/);
    names.add(name);
  }
  assert.equal(names.size, 100_000);
  assert.ok(piName(99_999_999).length <= 32);
});

test("byPi: the thread's own Pi, by its name or the old `pi`, and no other thread's", () => {
  const session = "thread-1956";
  assert.ok(byPi(1956, { profile: piName(1956), session }));
  assert.ok(byPi(1956, { profile: "pi", session }));
  assert.ok(!byPi(1956, { profile: piName(1957), session }));
  assert.ok(!byPi(1956, { profile: piName(1956), session: "thread-1957" }));
  assert.ok(!byPi(1956, { profile: null, session: null }));
});

test("thread: Pi says it's on it before long work, then posts updates as it goes", () => {
  assert.match(INSTRUCTIONS.thread, /several replies in one turn/);
  assert.match(INSTRUCTIONS.thread, /before you start, post a one-line reply saying what you're about to do/);
  assert.match(INSTRUCTIONS.thread, /a line when you reach a milestone/);
  assert.match(INSTRUCTIONS.thread, /quick answer is just the answer/);
});

test("review: no on-it or milestone lines, so a review doesn't comment on every PR", () => {
  assert.doesNotMatch(INSTRUCTIONS.review, /several replies in one turn/);
  assert.doesNotMatch(INSTRUCTIONS.review, /a line when you reach a milestone/);
});

test("piAvatar: a PNG generated from each Pi's name, the same every time", () => {
  assert.equal(piAvatar(1956), "https://vercel.com/api/www/avatar?s=64&format=png&u=clever-lemur-1956");
  assert.equal(piAvatar(1956), piAvatar(1956));
  assert.notEqual(piAvatar(1956), piAvatar(1957));
});

test("review: :looking-bunny: on the PR root while a review is underway, off once land is labeled", () => {
  assert.match(INSTRUCTIONS.review, /Before anything else, react to the PR thread's root with vb react <root id> looking-bunny/);
  assert.match(INSTRUCTIONS.review, /vb react <root id> looking-bunny --remove once you've labeled land/);
  assert.doesNotMatch(INSTRUCTIONS.thread, /looking-bunny/);
});

test("GITHUB_TOKEN: Pi never gets a cached GitHub token that dies before its session ends", async () => {
  const { getToken } = await import("@vercel/connect");
  const realFetch = globalThis.fetch;
  let minted = 0;
  globalThis.fetch = async () => {
    minted++;
    // Each token Connect mints here has 10 minutes left.
    return Response.json({ token: `t${minted}`, expiresAt: Date.now() + 10 * 60_000, connector: { id: "c", uid: "u", type: "github" } });
  };
  try {
    const options = { vercelToken: "oidc" };
    // The default 30s buffer hands the 10-minute token out again: the bug.
    const app = { subject: { type: "app" } };
    assert.equal(await getToken("github/test", app, options), await getToken("github/test", app, options));
    // Pi's asks for one that lasts the whole session, so it isn't reused.
    assert.notEqual(await getToken("github/test", GITHUB_TOKEN, options), await getToken("github/test", GITHUB_TOKEN, options));
    assert.ok(GITHUB_TOKEN.validityBufferMs >= 45 * 60_000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const person = (id, text, extra = {}) => ({
  id,
  text,
  by: { actor: "slack:user:U1", profile: null, session: null },
  author: { handle: "martin", name: "Martin Sione" },
  ...extra,
});
const pi = (id, thread, text) => ({
  id,
  text,
  by: { actor: "vercel:project:p:production", profile: piName(thread), session: `thread-${thread}` },
  author: { handle: piName(thread), name: piName(thread) },
});

test("quote: each message with the handle to mention, its files, and long text cut", () => {
  assert.equal(quote([person(5, "it breaks")]), "#5 Martin Sione (@martin):\nit breaks");
  assert.match(quote([person(5, "see the log", { attachments: [{}, {}] })]), /\[📎 2 attached: vb read 5 lists them\]$/);
  const long = quote([person(5, "x".repeat(5000))]);
  assert.ok(long.length < 4200);
  assert.match(long, /… \(cut: vb read 5 for the rest\)$/);
});

test("news quotes what's new since Pi's last reply, so Pi needn't read the thread first", () => {
  const thread = [person(10, "a bug"), pi(11, 10, "on it"), person(12, "also this"), person(13, "and that")];
  const message = newsMessage(10, sincePi(10, thread));
  assert.match(message, /^There's new activity in board thread #10\. Here's what's new since your last reply:/);
  assert.match(message, /#12 Martin Sione \(@martin\):\nalso this\n\n#13 Martin Sione \(@martin\):\nand that$/);
  assert.doesNotMatch(message, /on it|a bug/);
  // Another thread's Pi isn't this one: its messages are news.
  assert.equal(sincePi(10, [person(1, "x"), pi(2, 99, "elsewhere")]).length, 2);
  assert.equal(newsMessage(10, []), "There's new activity in board thread #10.");
});

test("news quotes at most the last 10 messages, and says where the rest are", () => {
  const thread = Array.from({ length: 14 }, (_, i) => person(i + 1, `m${i + 1}`));
  const message = newsMessage(1, sincePi(1, thread));
  assert.match(message, /\(the last 10; 4 before them: vb read 1\)/);
  assert.doesNotMatch(message, /\nm4\b/);
  assert.match(message, /\nm14$/);
});

for (const task of ["thread", "review"]) {
  test(`${task}: Pi waits for the repo the board prepares instead of cloning it`, () => {
    assert.match(INSTRUCTIONS[task], /~\/vboard/);
    assert.match(INSTRUCTIONS[task], /until \[ -e ~\/\.pi\/repo-ready \]/);
    assert.match(INSTRUCTIONS[task], /quotes what's new since your last reply/);
  });
}
