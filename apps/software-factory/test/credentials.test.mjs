import assert from "node:assert/strict";
import { test } from "node:test";
import { policy, UNTRUSTED } from "../app/api/board/[[...path]]/harness.ts";

const tokens = { gateway: "gw-secret", board: "board-secret", github: "gh-secret" };

test("a PR's own code runs with no credential added to any request", () => {
  const json = JSON.stringify(UNTRUSTED);
  assert.ok(!json.includes("transform"), "nothing rewrites requests on the way out");
  assert.deepEqual(UNTRUSTED.allow["*"], [], "the registry stays reachable for pnpm install");
  for (const host of ["api.github.com", "github.com", "ai-gateway.vercel.sh", new URL("https://vboard-factory.playground-vercel.tools").host]) {
    assert.ok(!(host in UNTRUSTED.allow), `${host} gets no rule of its own`);
  }
});

test("the normal policy is the one that carries the credentials", () => {
  const json = JSON.stringify(policy("42", tokens, "bypass-secret"));
  for (const secret of ["gw-secret", "board-secret", "gh-secret", "bypass-secret"]) {
    assert.ok(json.includes(secret), `${secret} is added by the normal policy`);
    assert.ok(!JSON.stringify(UNTRUSTED).includes(secret));
  }
});
