// What the page is told, on a board in memory: node --test test/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { board as makeBoard, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { snapshot } from "../lib/fleet.ts";
import { claim, create, finish } from "../lib/queue.ts";

const fresh = (): Board => makeBoard({ backend: local({ memory: true }) });
const look = (board: Board) => snapshot(board, "fleet/");
const states = (tasks: { title: string; state: string }[]) => Object.fromEntries(tasks.map((task) => [task.title, task.state]));
async function done(board: Board, title: string): Promise<string> {
  const id = await create(board, "fleet/fixes", { title, key: title });
  const held = await claim(board, id);
  assert.ok(held);
  assert.equal(await finish(held, "complete", `${title} landed`), true);
  return id;
}

test("a snapshot has the fleet's tasks with their state and holder, and nothing from other channels", async () => {
  const board = fresh();
  await create(board, "fleet/fixes", { title: "ready one", brief: "the brief", key: "a" });
  const held = await create(board, "fleet/perf", { title: "held one", key: "b" });
  const grace = board.as("grace");
  await claim(grace, held);
  await grace.reply(held, "[progress] on it");
  await done(board, "done one");
  await create(board, "other/fixes", { title: "another queue's", key: "c" });
  await board.post("fleet/general", "not a task");

  const snap = await look(board);
  assert.deepEqual(states(snap.tasks), { "ready one": "ready", "held one": "claimed", "done one": "completed" });
  const task = snap.tasks.find((task) => task.title === "held one")!;
  assert.equal(task.holder, "grace");
  assert.equal(task.channel, "fleet/perf");
  assert.ok(Date.parse(task.until!) > Date.now());
  assert.equal(snap.tasks.find((task) => task.title === "done one")!.note, "done one landed");
  assert.ok(snap.flow.some((line) => line.text === "not a task"));
  assert.ok(!snap.flow.some((line) => line.channel.startsWith("other/")));
});

test("a task that waits shows what it waits for, and is ready once that completes", async () => {
  const board = fresh();
  const fix = await create(board, "fleet/fixes", { title: "fix", key: "fix" });
  await create(board, "fleet/fixes", { title: "review", key: "review", needs: [fix] });
  const before = (await look(board)).tasks.find((task) => task.title === "review")!;
  assert.deepEqual([before.state, before.needs], ["waiting", [fix]]);

  const held = await claim(board, fix);
  await finish(held!, "complete");
  assert.deepEqual(states((await look(board)).tasks), { fix: "completed", review: "ready" });
});

test("a task made and finished between two snapshots shows in the next, though it was never seen open", async () => {
  const board = fresh();
  await create(board, "fleet/fixes", { title: "still ready", key: "a" });
  await look(board);
  await done(board, "quick one");
  assert.deepEqual(states((await look(board)).tasks), { "still ready": "ready", "quick one": "completed" });
});

test("failed and canceled tasks show how they ended, and a thread that isn't a task doesn't show", async () => {
  const board = fresh();
  const dropped = await create(board, "fleet/fixes", { title: "dropped", key: "a" });
  await board.tasks.cancel(dropped, "not wanted");
  const held = await claim(board, await create(board, "fleet/fixes", { title: "tried", key: "b" }));
  await finish(held!, "fail", "can't reproduce");
  await board.post("fleet/fixes", { text: "odd one", labels: { "task.state": "ready" } });
  const snap = await look(board);
  assert.deepEqual(states(snap.tasks), { dropped: "canceled", tried: "failed" });
  assert.deepEqual(
    snap.tasks.map((task) => task.note),
    ["can't reproduce", "not wanted"],
  );
});

test("a snapshot holds the newest 25 finished tasks and says there are more", async () => {
  const board = fresh();
  for (let i = 1; i <= 27; i++) await done(board, `done ${i}`);
  await create(board, "fleet/fixes", { title: "open", key: "open" });
  const snap = await look(board);
  const finished = snap.tasks.filter((task) => task.state === "completed").map((task) => task.title);
  assert.equal(snap.finishedCapped, true);
  assert.deepEqual(finished, Array.from({ length: 25 }, (_, i) => `done ${27 - i}`));
  assert.equal(snap.tasks.filter((task) => task.state === "ready").length, 1);

  const few = fresh();
  await done(few, "only one");
  assert.equal((await look(few)).finishedCapped, false);
});
