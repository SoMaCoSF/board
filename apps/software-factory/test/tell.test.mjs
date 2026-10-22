import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TELL } from "../app/api/board/[[...path]]/agent.ts";

// TELL runs in a Linux sandbox; macOS doesn't ship flock (util-linux).
const skip = spawnSync("flock", ["--version"]).error ? "needs flock" : false;

// A sandbox home with a fake `pi` that records each message it finishes a turn on, and can fail its next turn.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "tell-"));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, ".pi"));
  writeFileSync(
    join(home, "bin", "pi"),
    `#!/bin/bash\nif [ -e "$HOME/fail" ]; then rm "$HOME/fail"; exit 1; fi\necho "\${@: -1}" >> "$HOME/turns"\n`,
  );
  chmodSync(join(home, "bin", "pi"), 0o755);
  // Each message's text is its key, so a turn names the message Pi got.
  const start = (key) =>
    spawn("bash", ["-c", TELL], {
      env: { HOME: home, PATH: `${home}/bin:${process.env.PATH}`, KEY: key, MODEL: "m", SESSION: "s", INSTRUCTIONS: "i", MESSAGE: key },
    });
  const tell = async (key) => {
    const [code] = await once(start(key), "exit");
    if (code !== 0) throw new Error(`exit ${code}`);
  };
  const failNext = () => writeFileSync(join(home, "fail"), "");
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
  return { start, tell, turns, busy, failNext };
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

test("a turn Pi doesn't finish is tried again with the next message", { skip }, async () => {
  const { tell, turns, failNext } = sandbox();
  failNext();
  await tell("security-7").catch(() => {});
  await tell("news-8");
  assert.deepEqual(turns(), ["security-7", "news-8"]);
});

test("a message cut off while it waits behind a turn goes with the next one", { skip }, async () => {
  const { start, tell, turns, busy } = sandbox();
  const release = await busy();
  const waiting = start("kind-bug");
  await sleep(100);
  waiting.kill("SIGKILL");
  await once(waiting, "exit");
  await release();
  await tell("news-1");
  assert.deepEqual(turns(), ["kind-bug", "news-1"]);
});
