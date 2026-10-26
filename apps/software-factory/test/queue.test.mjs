import assert from "node:assert/strict";
import { test } from "node:test";
import { queueOptions } from "../app/api/board/[[...path]]/queue.ts";

test("production's queue reaches the current deployment, not the one that sent each message", () => {
  // Board #690: the sitrep schedules were armed before a deploy, so every send stayed on that old deployment,
  // which ran code from before the repo rename and couldn't start Pi's sandbox.
  assert.deepEqual(queueOptions("production"), { topic: "vboard-factory", deploymentId: null });
});

test("a preview's queue stays pinned to its own deployment, so its messages never land on production", () => {
  assert.deepEqual(queueOptions("preview"), { topic: "vboard-factory" });
  assert.equal("deploymentId" in queueOptions("preview"), false);
  assert.equal("deploymentId" in queueOptions(undefined), false);
});
