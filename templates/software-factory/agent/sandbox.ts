import pkg from "@vercel/board/package.json" with { type: "json" };
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { BOARD } from "./lib/identity";

/** The vb the sandbox gets: the board this deployment was built with. */
const VB = pkg.version;
/** Pinned: asking GitHub's API for the latest hits the unauthenticated rate limit sandboxes share. */
const GH = "2.102.0";

/** Sandbox setup, as root, once at build into the snapshot. */
const TOOLS = `set -e
command -v pnpm >/dev/null || npm install -g pnpm >/dev/null 2>&1
# --force takes over a vb another package installed.
[ "$(vb --version 2>/dev/null)" = "${VB}" ] || npm install -g --force @vercel/board@${VB} >/dev/null 2>&1
command -v gh >/dev/null || {
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH}/gh_${GH}_linux_amd64.tar.gz" | tar xz -C /tmp
  install "/tmp/gh_${GH}_linux_amd64/bin/gh" /usr/local/bin/gh
}`;

/** The sandbox's git, ahead of /usr/bin/git: a push to GitHub goes through its API, so GitHub signs it (skills/git-push). */
const GIT = `set -e
scripts="$HOME/.agents/skills/git-push/scripts"
test -x /usr/bin/git
sudo install -D -m 755 "$scripts/git" /usr/local/lib/factory/git
sudo install -D -m 644 "$scripts/git-push.mjs" /usr/local/lib/factory/git-push.mjs
sudo ln -sf /usr/local/lib/factory/git /usr/local/bin/git
[ "$(command -v git)" = /usr/local/bin/git ]`;

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    // A file, not `bash -c "…"`: inside double quotes the script's newlines stay `\n` and its `$(…)` run too early.
    await sandbox.writeTextFile({ path: "/tmp/factory-tools.sh", content: TOOLS });
    const tools = await sandbox.run({ command: "sudo bash /tmp/factory-tools.sh" });
    if (tools.exitCode !== 0) throw new Error(`sandbox setup failed: ${tools.stderr.slice(-500)}`);
    const scripts = await sandbox.run({ command: `{ chmod +x "$HOME"/.agents/skills/*/scripts/* 2>/dev/null || true; }` });
    if (scripts.exitCode !== 0) throw new Error(`sandbox setup failed: ${scripts.stderr.slice(-500)}`);
    await sandbox.writeTextFile({ path: "/tmp/factory-git.sh", content: GIT });
    const git = await sandbox.run({ command: "bash /tmp/factory-git.sh" });
    if (git.exitCode !== 0) throw new Error(`sandbox git setup failed: ${git.stderr.slice(-500)}`);
  },
});

// Credentials are placeholders: lib/credentials.ts puts the real ones in the network policy, never in the sandbox.
export default defineSandbox(() =>
  environment.open({
    resources: { vcpus: 4 },
    timeout: 45 * 60_000,
    networkPolicy: "deny-all",
    env: {
      AI_GATEWAY_API_KEY: "from-the-network-policy",
      BOARD_URL: BOARD,
      BOARD_TOKEN: "from-the-network-policy",
      GH_TOKEN: "from-the-network-policy",
    },
  }),
);
