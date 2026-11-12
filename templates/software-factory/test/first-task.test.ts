import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import type { AgentMessage } from "../agent/lib/wake.ts";
import { firstTask, ownRequest, startFirstTask, templateReadme } from "../lib/first-task.ts";

// The factory's first task, started as the page starts it, on a real board kept in memory: what
// lands on the board is what people see, and what reaches the agent is what `wake` gets.

const TEMPLATE_README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("the template's own README is the template's, and one without its Deploy button isn't", () => {
  assert.equal(templateReadme(TEMPLATE_README), true);
  assert.equal(templateReadme("# Acme's factory\n\nIt works on acme/web.\n"), false);
  // A README that can't be read is nobody's to rewrite.
  assert.equal(templateReadme(undefined), false);
});

test("starting it opens one thread where the factory changes itself, and hands it to the agent", async () => {
  const team = board({ backend: local({ memory: true }) });
  const woken: AgentMessage[] = [];
  const root = await startFirstTask(team, "project-factory/rsi", async (message) => void woken.push(message));
  const { messages } = await team.messages({ channel: "project-factory/" });
  assert.deepEqual(messages.map((message) => [message.id, message.channel, message.re]), [[root.id, "project-factory/rsi", null]]);
  // It says what to do, so the agent that reads it needs nothing else.
  assert.match(messages[0]!.text, /README/);
  assert.deepEqual(woken.map(({ thread, text }) => [thread, text]), [[root.id, `New board thread #${root.id}.`]]);
  // And the page can tell it started.
  assert.equal(firstTask(TEMPLATE_README, messages), "started");
});

test("asked twice, it starts once: one thread, and the same wake-up key, which the agent's channel takes once", async () => {
  const team = board({ backend: local({ memory: true }) });
  const woken: AgentMessage[] = [];
  const wake = async (message: AgentMessage) => void woken.push(message);
  const first = await startFirstTask(team, "project-factory/rsi", wake);
  const again = await startFirstTask(team, "project-factory/rsi", wake);
  assert.equal(again.id, first.id);
  assert.equal((await team.messages({ channel: "project-factory/" })).messages.length, 1);
  assert.equal(new Set(woken.map((message) => message.key)).size, 1);
});

test("a team's factories share a board, and each starts its own first task there", async () => {
  const team = board({ backend: local({ memory: true }) });
  const wake = async () => {};
  const a = await startFirstTask(team, "project-web/rsi", wake);
  const b = await startFirstTask(team, "project-api/rsi", wake);
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await team.messages({ channel: "project-api/" })).messages.map((message) => message.id), [b.id]);
});

test("the first task is on offer while the README is the template's and nothing started it, and gone once the README is the team's", async () => {
  const team = board({ backend: local({ memory: true }) });
  await team.post("project-factory/rsi", "hello");
  const { messages } = await team.messages({ channel: "project-factory/" });
  assert.equal(firstTask(TEMPLATE_README, messages), "offer");
  assert.equal(firstTask(TEMPLATE_README, []), "offer");
  assert.equal(firstTask("# Acme's factory\n", messages), null);
  assert.equal(firstTask(undefined, messages), null);
});

test("only the deployment's own page, or something that isn't a browser, starts it", () => {
  assert.equal(ownRequest("https://factory.acme.dev", "factory.acme.dev"), true);
  // No Origin: the Vercel CLI, an agent setting the factory up.
  assert.equal(ownRequest(null, "factory.acme.dev"), true);
  assert.equal(ownRequest("https://evil.example", "factory.acme.dev"), false);
  assert.equal(ownRequest("https://factory.acme.dev.evil.example", "factory.acme.dev"), false);
  assert.equal(ownRequest("null", "factory.acme.dev"), false);
});
