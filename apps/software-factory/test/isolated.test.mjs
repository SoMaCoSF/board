import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { policy } from "../app/api/board/[[...path]]/harness.ts";
import { ISOLATED_POLICY, packCommand, runsProjectCode } from "../agent/lib/isolated.ts";

test("the isolated sandbox adds no credential to any request, while Eve's policy does", () => {
  const secrets = ["gw-secret", "board-secret", "gh-secret", "bypass-secret"];
  const eve = JSON.stringify(policy("42", { gateway: secrets[0], board: secrets[1], github: secrets[2] }, secrets[3]));
  const isolated = JSON.stringify(ISOLATED_POLICY);
  for (const secret of secrets) {
    assert.ok(eve.includes(secret));
    assert.ok(!isolated.includes(secret));
  }
  assert.ok(!isolated.includes("transform"));
});

test("the copy has the checkout's tracked files as edited, and no .git or untracked files", () => {
  const dir = mkdtempSync(join(tmpdir(), "isolated-"));
  const sh = (cmd) => execSync(cmd, { cwd: dir, encoding: "utf8" });
  sh("git init -q && git config user.email t@t && git config user.name t");
  writeFileSync(join(dir, "a.txt"), "committed\n");
  sh("git add a.txt && git commit -qm a");
  writeFileSync(join(dir, "a.txt"), "edited\n");
  writeFileSync(join(dir, "secret.env"), "untracked\n");
  const out = join(dir, "..", `${dir.split("/").pop()}.tgz`);
  execSync(packCommand(dir, out), { shell: "/bin/bash" });
  assert.deepEqual(execSync(`tar tzf ${out}`, { encoding: "utf8" }).trim().split("\n"), ["a.txt"]);
  assert.equal(execSync(`tar xzOf ${out} a.txt`, { encoding: "utf8" }), "edited\n");

  sh("git checkout -q a.txt");
  execSync(packCommand(dir, out), { shell: "/bin/bash" });
  assert.equal(execSync(`tar xzOf ${out} a.txt`, { encoding: "utf8" }), "committed\n");
});

test("a review's bash refuses package managers and node, and lets the rest and the deepsec steps through", () => {
  for (const cmd of ["pnpm install", "cd board && pnpm check", "npx vitest run", "git pull; npm test", "node scripts/x.js", "(pnpm test)", "CI=1 pnpm test", "sudo npm ci", "echo $(node -v)"]) {
    assert.equal(runsProjectCode(cmd), true, cmd);
  }
  for (const cmd of [
    "gh pr diff 12",
    "git log --oneline",
    "grep -rn pnpm SPEC.md",
    "cat package.json | jq .scripts.node",
    "command -v claude || (cd /tmp && npm i -g @anthropic-ai/claude-code)",
    "timeout 30m env CLAUDE_CODE_EXECUTABLE=claude npx -y deepsec process --diff origin/main...HEAD --comment-out deepsec.md > deepsec.log 2>&1",
  ]) {
    assert.equal(runsProjectCode(cmd), false, cmd);
  }
});
