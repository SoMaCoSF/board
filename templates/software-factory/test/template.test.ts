import assert from "node:assert/strict";
import { test } from "node:test";
import { latest, newer } from "../agent/lib/template.ts";

test("a later release is newer, by each part as a number", () => {
  assert.equal(newer("0.31.0", "0.30.0"), true);
  assert.equal(newer("0.30.10", "0.30.9"), true);
  assert.equal(newer("1.0.0", "0.99.99"), true);
});

test("the same release, an older one, or a prerelease isn't newer", () => {
  assert.equal(newer("0.30.0", "0.30.0"), false);
  assert.equal(newer("0.29.9", "0.30.0"), false);
  assert.equal(newer("0.31.0-next.1", "0.30.0"), false);
});

test("the latest release is npm's latest for @vercel/board", async () => {
  const asked: string[] = [];
  const version = await latest((async (url: string) => (asked.push(url), new Response(JSON.stringify({ version: "0.31.2" })))) as never);
  assert.equal(version, "0.31.2");
  assert.deepEqual(asked, ["https://registry.npmjs.org/@vercel/board/latest"]);
});
