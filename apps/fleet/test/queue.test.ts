// The queue's promises, on a board in memory: node --test test/*.test.ts
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { board as makeBoard, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { claim, create, finish, renew } from "../lib/queue.ts";

const fresh = (): Board => makeBoard({ backend: local({ memory: true }) });
const state = async (board: Board, id: string) => (await board.thread(id)).message.task?.state;
let n = 0;
const task = (board: Board, needs?: string[]) => create(board, "fleet/fixes", { title: `task ${++n}`, key: `key-${n}`, needs });

test("a retried create makes one task", async () => {
  const board = fresh();
  const first = await create(board, "fleet/fixes", { title: "Fix the redirect", brief: "Same-origin only.", key: "fix-redirect" });
  const again = await create(board, "fleet/fixes", { title: "Fix the redirect", brief: "Same-origin only.", key: "fix-redirect" });
  assert.equal(again, first);
  const { tasks } = await board.tasks.list({ channel: "fleet/" });
  assert.deepEqual(
    tasks.map(({ message }) => [message.text, message.task?.state]),
    [["Fix the redirect\n\nSame-origin only.", "ready"]],
  );
});

test("of many agents claiming one task at once, one gets it", async () => {
  const board = fresh();
  const id = await task(board);
  const agents = ["ada", "grace", "linus", "ken", "barbara", "edsger", "margaret", "dennis"].map((name) => board.as(name));
  const claims = await Promise.all(agents.map((agent) => claim(agent, id)));
  const won = claims.filter((held) => held !== null);
  assert.equal(won.length, 1);
  const { message } = await board.thread(id);
  assert.equal(message.task?.state, "claimed");
  assert.equal(message.task?.claim?.actor, (await agents[claims.indexOf(won[0]!)]!.me()).actor);
});

test("a renewal moves the end of the claim later", async () => {
  const board = fresh();
  const held = await claim(board, await task(board));
  assert.ok(held);
  await new Promise((resolve) => setTimeout(resolve, 1_100)); // a lease is kept to the second
  const renewed = await renew(held);
  assert.ok(renewed);
  assert.ok(Date.parse(renewed.until) > Date.parse(held.until));
});

test("a stalled task is taken over, and the agent that held it can't settle it", async (t) => {
  const board = fresh();
  const id = await task(board);
  const old = await claim(board.as("ada"), id);
  assert.ok(old);
  assert.equal(await claim(board.as("grace"), id), null, "a live claim holds it");

  // The lease runs out on the board's clock.
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
  mock.timers.tick(Date.parse(old.until) - Date.now() + 1_000);

  const taken = await claim(board.as("grace"), id);
  assert.ok(taken, "anyone may take over a lapsed claim");
  assert.equal(await renew(old), null);
  assert.equal(await finish(old, "complete", "late"), false);
  const { message } = await board.thread(id);
  assert.equal(message.task?.state, "claimed");
  assert.equal(message.task?.claim?.actor, (await board.as("grace").me()).actor);
});

test("a completed task readies the tasks that waited for it, and no others", async () => {
  const board = fresh();
  const first = await task(board);
  const other = await task(board);
  const waits = await task(board, [first]);
  const waitsForOther = await task(board, [other]);
  assert.equal(await state(board, waits), "waiting");
  assert.equal(await claim(board, waits), null, "a waiting task can't be claimed");

  const held = await claim(board, first);
  assert.ok(held);
  assert.equal(await finish(held, "complete", "fixed"), true);

  const { message } = await board.thread(first);
  assert.deepEqual([message.task?.state, message.task?.result], ["completed", "fixed"]);
  assert.equal(await state(board, waits), "ready");
  assert.equal(await state(board, waitsForOther), "waiting");
});

test("a failed task keeps what waits for it waiting", async () => {
  const board = fresh();
  const fix = await task(board);
  const review = await task(board, [fix]);
  const held = await claim(board, fix);
  assert.ok(held);
  assert.equal(await finish(held, "fail", "can't reproduce"), true);
  const { message } = await board.thread(fix);
  assert.deepEqual([message.task?.state, message.task?.reason], ["failed", "can't reproduce"]);
  assert.equal(await state(board, review), "waiting");
});

test("an agent that gives a task back leaves it ready for anyone, and its claim settles nothing", async () => {
  const board = fresh();
  const id = await task(board);
  const held = await claim(board.as("ada"), id);
  assert.ok(held);
  assert.equal(await finish(held, "release"), true);
  const { message } = await board.thread(id);
  assert.deepEqual([message.task?.state, message.task?.claim], ["ready", null]);
  assert.equal(await renew(held), null, "the old claim no longer holds it");
  assert.equal(await finish(held, "complete"), false);
  assert.ok(await claim(board.as("grace"), id));
});
