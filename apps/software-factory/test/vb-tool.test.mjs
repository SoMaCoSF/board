import assert from "node:assert/strict";
import { test } from "node:test";
import { board as boardAt } from "@vercel/board";
import { DEV, eveName, eveSession } from "../app/api/board/[[...path]]/harness.ts";
import { eveFetch, eveScope } from "../app/api/board/[[...path]]/eve-fetch.ts";
import { callSignal, eveBoard, runVb, SANDBOX_HOME } from "../agent/lib/vb-tool.ts";
import { fakeMessageboard } from "../../../packages/board/test/messageboard.ts";

// The factory's board is Vercel's, never one at a URL the environment names.
delete process.env.BOARD_URL;
delete process.env.BOARD_TOKEN;
process.env.VERCEL_PROJECT_ID = "prj_factory";

const PROJECT = "project:prj_factory:production";

// Files go to the storage URLs the API signs, with no credentials: the latest fake's.
let storage;
const real = globalThis.fetch;
globalThis.fetch = (input, init) =>
  new URL(String(input instanceof Request ? input.url : input)).hostname === "storage.test" ? storage(input, init) : real(input, init);

// The vb tool on a board like the factory's: Vercel's, here a fake of its API, through `eveFetch`
// with the deployment's token, and an Eve's session while `asEve` names its thread.
async function setup(thread = "1419", { watch } = {}) {
  const api = fakeMessageboard();
  storage = api.files;
  const sent = [];
  // As factory.ts has it: the board's first use, outside any command, reads its channels.
  const scope = eveScope(() => factory.channels());
  const factory = boardAt({
    team: "team_test",
    ...(watch ? { watch } : {}),
    fetch: eveFetch({
      token: async () => PROJECT,
      call: scope.call,
      fetch: (input, init) => {
        sent.push({ path: new URL(String(input)).pathname, session: new Headers(init?.headers).get("x-board-session"), call: scope.call() });
        return api.fetch(input, init);
      },
    }),
  });
  const person = boardAt({ team: "team_test", fetch: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", "Bearer user:u_jb");
    return api.fetch(input, { ...init, headers });
  } });
  const root = await person.post(DEV, "add a vb tool to eve", { noSync: true });
  const files = new Map();
  const sandbox = async () => ({
    readBinaryFile: async ({ path }) => files.get(path) ?? null,
    writeBinaryFile: async ({ path, content }) => void files.set(path, content),
  });
  const handle = eveBoard(factory, thread);
  const run = (...args) => scope.asEve({ thread }, () => runVb(handle, args, sandbox));
  return { eve: handle, factory, root, sent, files, run, api, scope };
}

test("vb tool: writes as the thread's Eve: the factory's production project, under its name and session", async () => {
  const { eve, root, run } = await setup();
  const id = await run("reply", root.id, "on it");
  const reply = (await eve.thread(root.id)).replies.find((m) => m.id === id);
  assert.equal(reply.text, "on it");
  assert.equal(reply.by.profile, eveName("1419"));
  assert.equal(reply.by.session, eveSession("1419"));
  assert.equal(reply.by.principal, "vercel:project:prj_factory:production");
});

test("vb tool: the factory's own writes outside an Eve's command carry no Eve's session", async () => {
  const { factory, root, run } = await setup();
  await run("reply", root.id, "Eve's");
  const own = await factory.reply(root.id, "the board's own");
  assert.equal(own.by.session, null);
});

test("vb tool: an Eve's command as the board's first use starts the watchers outside it, and they never run as that Eve", async () => {
  const errors = [];
  const error = console.error;
  const warn = console.warn;
  console.error = console.warn = (...args) => void errors.push(args.map(String).join(" "));
  try {
    const { run, sent } = await setup("1419", { watch: { triage: { tail: DEV, run: async () => {} } } });
    assert.match(await run("read", DEV), /add a vb tool to eve/);
    // The board registers its watchers on its first use, in the background, and then pulls their matches.
    const until = Date.now() + 10_000;
    while (!sent.some(({ path }) => path.endsWith("/watchers/matches")) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    const watchers = sent.filter(({ path }) => /\/watchers(\/|$)/.test(path));
    assert.deepEqual([...new Set(watchers.map(({ path }) => path.replace(/^.*\/boards\/[^/]+/, "")))].sort(), ["/watchers", "/watchers/matches"]);
    // In no Eve's command, so what the watchers write is theirs, not an Eve's.
    assert.ok(watchers.every(({ call, session }) => call === undefined && session === null));
    assert.deepEqual(errors.filter((line) => /couldn't (register|pull)/.test(line)), []);
  } finally {
    console.error = error;
    console.warn = warn;
  }
});

test("vb tool: prints what vb prints, and says how a command failed", async () => {
  const { root, run } = await setup();
  await run("reply", root.id, "first reply");
  const text = await run("read", root.id);
  assert.match(text, /add a vb tool to eve/);
  assert.match(text, /first reply/);
  assert.match(await run("read", DEV, "--text", "vb tool"), /^vboard\/dev · 1 thread · cursor/);
  assert.equal(await run("label", root.id, "kind=bug"), `labeled ${root.id}`);
  // tail and wait would hold every other Eve's calls on the instance: they stay in bash.
  for (const args of [["tail", DEV], ["wait", DEV], ["--as", "x", "tail", DEV], ["--by", "ada", "wait"], ["--mentions", "tail", DEV]]) {
    const word = args.includes("tail") ? "tail" : "wait";
    assert.equal(await run(...args), `error: ${word} isn't available here.\nrun vb ${word} in bash instead\n(exit 2)`);
  }
  // A reply saying "wait" is a reply.
  assert.match(await run("reply", root.id, "wait"), /^msg_/);
});

test("vb tool: --attach and download use the sandbox's files, ~ and $HOME in its home", async () => {
  const { eve, root, files, run } = await setup();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  files.set(`${SANDBOX_HOME}/board/shot.png`, png);
  for (const path of ["~/board/shot.png", "$HOME/board/shot.png"]) {
    const id = await run("reply", root.id, "PR: #1", "--attach", path);
    assert.deepEqual((await eve.thread(root.id)).replies.find((m) => m.id === id).attachments.map((a) => [a.name, a.size]), [["shot.png", png.byteLength]]);
  }
  assert.match(await run("reply", root.id, "x", "--attach", "/tmp/missing.png"), /Can't attach \/tmp\/missing\.png\. There's no such file\.\n\(exit 2\)$/);
  const [attachment] = (await eve.thread(root.id)).replies.at(-1).attachments;
  assert.equal(await run("download", attachment.id, "~/copy.png"), "~/copy.png");
  assert.deepEqual(files.get(`${SANDBOX_HOME}/copy.png`), png);
});

test("vb tool: reads nothing the platforms sent outside the board's channels, and reaches no sync records, watchers, grants or tokens", async () => {
  const { root, run, sent } = await setup();
  await run("read", root.id);
  const before = sent.length;
  for (const args of [["sources", "slack", "read", "#general"], ["inbox", "slack"], ["identity"], ["tokens"], ["grants"], ["hooks"], ["conformance"]])
    assert.match(await run(...args), /isn't available here[\s\S]*\(exit 2\)$/, args.join(" "));
  assert.equal(sent.length, before);
  assert.match(await run("read", root.id), /add a vb tool to eve/);
  const { eveReaches } = await import("../app/api/board/[[...path]]/eve-fetch.ts");
  const at = (path) => new URL(`https://api.vercel.com/v1/messageboard${path}`);
  for (const path of ["/me", "/boards", "/boards/brd_1/threads/thr_1/messages", "/boards/brd_1/attachments", "/boards/brd_1/sync/copies", "/boards/brd_1/schedules"])
    assert.ok(eveReaches(at(path)), path);
  for (const path of [
    "/boards/ensure",
    "/boards/default",
    "/boards/brd_1/sync/imports",
    "/boards/brd_1/sync/receipts",
    "/boards/brd_1/sync/inbox/slack",
    "/boards/brd_1/sync/inbox/slack/next",
    "/boards/brd_1/grants",
    "/boards/brd_1/tokens",
  ]) assert.ok(!eveReaches(at(path)), path);
  assert.ok(!eveReaches(new URL("https://api.vercel.com/v9/projects")));
});

test("vb tool: a command's signal ends the requests it makes", async () => {
  const scope = eveScope(async () => {});
  let request;
  const send = eveFetch({ token: async () => PROJECT, call: scope.call, fetch: (_input, init) => {
    request = init;
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  } });
  const signal = AbortSignal.timeout(50);
  await assert.rejects(scope.asEve({ thread: "1419", signal }, () => send("https://api.vercel.com/v1/messageboard/me")));
  assert.ok(request.signal.aborted);
  // Outside a command, nothing but the caller's own signal ends it.
  await send("https://api.vercel.com/v1/messageboard/me", { signal: AbortSignal.timeout(0) }).catch(() => {});
  assert.equal(request.headers.get("x-board-session"), null);
});

test("vb tool: a watcher registration retried during an Eve's command goes as the project, not refused", async () => {
  const scope = eveScope(async () => {});
  const seen = [];
  const send = eveFetch({ token: async () => PROJECT, call: scope.call, fetch: async (input, init) => {
    seen.push([new URL(String(input)).pathname, new Headers(init.headers).get("x-board-session")]);
    return Response.json({});
  } });
  await scope.asEve({ thread: "1419" }, async () => {
    await send("https://api.vercel.com/v1/messageboard/boards/brd_1/watchers", { method: "PUT" });
    await send("https://api.vercel.com/v1/messageboard/boards/brd_1/watchers/matches");
    await send("https://api.vercel.com/v1/messageboard/boards/brd_1/channels");
    await assert.rejects(send("https://api.vercel.com/v1/messageboard/boards/brd_1/grants"), /can't reach \/boards\/brd_1\/grants/);
  });
  assert.deepEqual(seen, [
    ["/v1/messageboard/boards/brd_1/watchers", null],
    ["/v1/messageboard/boards/brd_1/watchers/matches", null],
    ["/v1/messageboard/boards/brd_1/channels", "thread-1419"],
  ]);
});

test("vb tool: a call that hangs ends with its signal, and frees the calls behind it", async () => {
  const { eve, root } = await setup();
  // A board that never answers.
  const signal = callSignal(undefined, 50);
  const hung = eveBoard(boardAt({ team: "team_test", fetch: (_input, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) }), "1419");
  const none = async () => ({ readBinaryFile: async () => null, writeBinaryFile: async () => {} });
  assert.match(await runVb(hung, ["read", root.id], none, signal), /\(exit 1\)$/);
  // The queue moved on.
  assert.match(await runVb(eve, ["read", root.id], none), /add a vb tool to eve/);
});
