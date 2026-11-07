import type { NetworkPolicy } from "@vercel/sandbox";

// A PR's code (its install, lifecycle scripts, tests, CLI) runs in a sandbox of its own, never in Eve's:
// Eve's network policy adds the factory App's GitHub token and Eve's board token to every request, and
// code that ran there once could stay behind (a background process, a hook) after any switch-off.

/** The isolated sandbox's policy: the open internet for the registry, with no credential added anywhere. */
export const ISOLATED_POLICY: NetworkPolicy = { allow: { "*": [] } };

export const ISOLATED_ROOT = "/vercel/sandbox/checkout";
export const ISOLATED_DEFAULT = "pnpm install --frozen-lockfile && pnpm check";

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Packs a checkout's tracked files as they are in the working tree (uncommitted edits included, so
 * Eve can break a line and watch a test fail), without .git or anything untracked.
 */
export function packCommand(dir: string, out: string) {
  return `cd ${quote(dir)} && ref=$(git stash create) && git archive --format=tar.gz -o ${quote(out)} "\${ref:-HEAD}"`;
}

/** What the isolated sandbox runs: unpack, put pnpm on the PATH, then the command, all output on stdout. */
export function isolatedScript(archive: string, command: string) {
  return [
    "set -e",
    `mkdir -p ${ISOLATED_ROOT}`,
    `tar xzf ${quote(archive)} -C ${ISOLATED_ROOT}`,
    `cd ${ISOLATED_ROOT}`,
    "command -v pnpm >/dev/null || sudo npm install -g pnpm >/dev/null 2>&1",
    `exec bash -c ${quote(command)} 2>&1`,
  ].join("\n");
}

/** A runner in a command's position: at the start, or after ; & | ( ` or $(, past env assignments and sudo, env or timeout. */
const RUNNERS = /(^|[;&|(`])\s*(\w+=\S*\s+)*((sudo|env|timeout\s+\S+)\s+)*(pnpm|npm|npx|yarn|bun|bunx|node|tsx|vitest)(\s|$)/;
/** The :security: review's own steps (security.ts), which need the AI gateway and stay in Eve's sandbox. */
const DEEPSEC = /\(cd \/tmp && npm i -g @anthropic-ai\/claude-code\)|^\s*timeout \S+ env CLAUDE_CODE_EXECUTABLE=claude npx -y deepsec process /;

/** Whether a bash command in a review session would run code the PR controls: package managers and node. */
export function runsProjectCode(command: string) {
  return RUNNERS.test(command) && !DEEPSEC.test(command);
}
