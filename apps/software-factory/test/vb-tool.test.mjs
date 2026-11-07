import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { board as boardAt } from "@vercel/board";
import { DEV, eveName, eveSession } from "../app/api/board/[[...path]]/harness.ts";
import { eveFetch } from "../app/api/board/[[...path]]/eve-fetch.ts";
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
async function setup(thread = "1419") {
  const api = fakeMessageboard();
  storage = api.files;
  const sent = [];
  const eve = new AsyncLocalStorage();
  const factory = boardAt({
    team: "team_test",
    fetch: eveFetch({
      token: async () => PROJECT,
      thread: () => eve.getStore(),
      fetch: (input, init) => {
        sent.push(new URL(String(input)).pathname);
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
  const run = (...args) => eve.run(thread, () => runVb(handle, args, sandbox));
  return { eve: handle, factory, root, sent, files, run, api };
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
  const before = sent.length;
  for (const args of [["sources", "slack", "read", "#general"], ["inbox", "slack"], ["identity"]])
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
    "/boards/brd_1/watchers",
    "/boards/brd_1/watchers/matches",
    "/boards/brd_1/grants",
    "/boards/brd_1/tokens",
  ]) assert.ok(!eveReaches(at(path)), path);
  assert.ok(!eveReaches(new URL("https://api.vercel.com/v9/projects")));
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
