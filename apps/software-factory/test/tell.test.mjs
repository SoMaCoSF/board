import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TELL } from "../app/api/board/[[...path]]/agent.ts";

// TELL runs in a Linux sandbox; macOS doesn't ship flock (util-linux).
const skip = spawnSync("flock", ["--version"]).error ? "needs flock" : false;

// A sandbox home with a fake `pi` that records each turn it's asked to run.
function sandbox(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "tell-"));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, ".pi"));
  writeFileSync(join(home, "bin", "pi"), `#!/bin/bash\necho "$KEY" >> "$HOME/turns"\n`);
  chmodSync(join(home, "bin", "pi"), 0o755);
  const tell = (key) =>
    new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", TELL], {
        env: { HOME: home, PATH: `${home}/bin:${process.env.PATH}`, KEY: key, MODEL: "m", SESSION: "s", INSTRUCTIONS: "i", MESSAGE: "There's new activity.", ...extra },
      });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
  const turns = () => (existsSync(join(home, "turns")) ? readFileSync(join(home, "turns"), "utf8").trim().split("\n") : []);
  // A turn that's still running: holds Pi's lock until released.
  const busy = async () => {
    const gate = join(home, "gate");
    const ready = join(home, "ready");
    writeFileSync(gate, "");
    const holder = spawn("flock", [join(home, ".pi", "lock"), "bash", "-c", `touch ${ready}; while [ -e ${gate} ]; do sleep 0.05; done`]);
    while (!existsSync(ready)) await sleep(10);
    return () => new Promise((resolve) => { holder.on("exit", resolve); execFileSync("rm", [gate]); });
  };
  return { home, tell, turns, busy };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("replies that pile up behind a running turn wake Pi once, not once each", { skip }, async () => {
  const { tell, turns, busy } = sandbox();
  const release = await busy();
  const queued = [];
  for (const key of ["news-1174", "news-1175", "news-1179", "news-1184"]) {
    queued.push(tell(key));
    await sleep(100);
  }
  await release();
  await Promise.all(queued);
  // Pi reads everything new itself, so the newest wake-up covers the ones before it.
  assert.deepEqual(turns(), ["news-1184"]);
});

test("tasks (a kind, a shipit, a review) are never dropped, even behind a turn", { skip }, async () => {
  const { tell, turns, busy } = sandbox();
  const release = await busy();
  const queued = [];
  for (const key of ["kind-bug", "news-1", "shipit-9", "news-2"]) {
    queued.push(tell(key));
    await sleep(100);
  }
  await release();
  await Promise.all(queued);
  assert.deepEqual(turns().sort(), ["kind-bug", "news-2", "shipit-9"]);
});

test("a message is still delivered once: a retried watcher is a no-op", { skip }, async () => {
  const { tell, turns } = sandbox();
  await tell("news-1");
  await tell("news-1");
  await tell("news-2");
  assert.deepEqual(turns(), ["news-1", "news-2"]);
});

// Fakes for the repo's prefetch: gh "clones" by making the directory (or fails, with GH_FAILS), pnpm "installs" by leaving a mark.
function fakeTools(home) {
  writeFileSync(join(home, "bin", "gh"), `#!/bin/bash\necho "$@" >> "$HOME/gh-calls"\n[ -n "$GH_FAILS" ] && exit 128\nmkdir -p "$4/.git"\n`);
  writeFileSync(join(home, "bin", "pnpm"), `#!/bin/bash\necho "$PWD $@" >> "$HOME/pnpm-calls"\n`);
  chmodSync(join(home, "bin", "gh"), 0o755);
  chmodSync(join(home, "bin", "pnpm"), 0o755);
}

const waitFor = async (path) => {
  for (let i = 0; i < 100 && !existsSync(path); i++) await sleep(20);
  return existsSync(path);
};
const done = (home) => readFileSync(join(home, ".pi", "repo-done"), "utf8").trim();

test("the repo is cloned and installed in the background, once per sandbox", { skip }, async () => {
  const { home, tell, turns } = sandbox({ REPO: "basehub-ai/vboard" });
  fakeTools(home);
  await tell("kind-bug");
  await tell("news-1");
  assert.ok(await waitFor(join(home, ".pi", "repo-done")), "repo-done marks it finished");
  assert.equal(done(home), "0");
  assert.deepEqual(turns(), ["kind-bug", "news-1"], "Pi doesn't wait for it");
  assert.equal(readFileSync(join(home, "gh-calls"), "utf8"), `repo clone basehub-ai/vboard ${home}/vboard -- -q\n`);
  assert.equal(readFileSync(join(home, "pnpm-calls"), "utf8"), `${home}/vboard install --frozen-lockfile\n`);
});

test("a clone Pi made before is reused, not cloned over (which would fail)", { skip }, async () => {
  const { home, tell } = sandbox({ REPO: "basehub-ai/vboard" });
  fakeTools(home);
  mkdirSync(join(home, "vboard", ".git"), { recursive: true });
  await tell("news-1");
  assert.ok(await waitFor(join(home, ".pi", "repo-done")));
  assert.equal(done(home), "0");
  assert.equal(existsSync(join(home, "gh-calls")), false);
  assert.equal(readFileSync(join(home, "pnpm-calls"), "utf8"), `${home}/vboard install --frozen-lockfile\n`);
});

test("a failed clone still says it's done, with its exit code, so Pi's wait ends at once", { skip }, async () => {
  const { home, tell } = sandbox({ REPO: "basehub-ai/vboard", GH_FAILS: "1" });
  fakeTools(home);
  await tell("kind-bug");
  assert.ok(await waitFor(join(home, ".pi", "repo-done")));
  assert.equal(done(home), "128");
  assert.equal(existsSync(join(home, "pnpm-calls")), false);
});

test("without a repo to prepare, nothing is cloned", { skip }, async () => {
  const { home, tell } = sandbox();
  fakeTools(home);
  await tell("kind-bug");
  await sleep(100);
  assert.equal(existsSync(join(home, "gh-calls")), false);
  assert.equal(existsSync(join(home, ".pi", "repo-done")), false);
});
