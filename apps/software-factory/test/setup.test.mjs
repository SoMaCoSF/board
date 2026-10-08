import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SETUP } from "../app/api/board/[[...path]]/agent.ts";

// A new sandbox, as setup sees it: pi and vb already there, no gh, and a network where GitHub's
// API refuses it (sandboxes share its unauthenticated rate limit) but release downloads work.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "setup-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const tool of ["tar", "gzip", "mkdir", "mktemp", "basename", "cp", "sed", "cat"]) {
    symlinkSync(execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  const fake = (name, script) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("pi", "exit 0");
  fake("vb", "exit 0");
  fake("npm", "exit 0");
  fake("install", 'cp "$1" "$HOME/gh"');
  fake(
    "curl",
    `url="\${@: -1}"
case "$url" in
  https://api.github.com/*) echo "curl: (22) The requested URL returned error: 403" >&2; exit 22 ;;
  https://github.com/cli/cli/releases/download/v[0-9]*/gh_[0-9]*_linux_amd64.tar.gz)
    name=$(basename "$url" .tar.gz); dir=$(mktemp -d); mkdir -p "$dir/$name/bin"
    printf '#!/bin/sh\\n' > "$dir/$name/bin/gh"; tar czf - -C "$dir" "$name" ;;
  *) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
esac`,
  );
  const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const run = () => spawnSync(bash, ["-c", SETUP], { env: { HOME: home, PATH: bin }, encoding: "utf8" });
  return { run, gh: join(home, "gh") };
}

test("a new sandbox gets gh while GitHub's API refuses it", () => {
  const { run, gh } = sandbox();
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  assert.ok(existsSync(gh), "gh is installed");
});
