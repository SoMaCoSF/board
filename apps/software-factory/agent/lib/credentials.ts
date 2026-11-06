import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { BOARD, eveName, policy, UNTRUSTED } from "../../app/api/board/[[...path]]/harness.ts";
import { CONNECTOR } from "../../app/api/board/[[...path]]/github.ts";
import { expiresAt, stale } from "../../app/api/board/[[...path]]/tokens.ts";
import { environment } from "../sandbox";
import type { Board } from "./board";

// Real credentials go in the sandbox's network policy, never in the sandbox.

const GITHUB_MS = 30 * 60_000;
const GIT_EMAIL = "pi@vboard-factory.playground-vercel.tools";

/** `off` while a PR's code runs: nothing puts the credentials back until it's done. */
const given = defineState("factory.credentials", () => ({ until: 0, off: false }));

/** Puts fresh tokens and git's identity in the sandbox: always with `force` (each turn's start, which also covers a sandbox eve recreated), else when they're near their end. */
export async function give(ctx: Pick<ToolContext, "getSandbox">, board: Board, { force = false } = {}) {
  const now = Date.now();
  if (given.get().off) return;
  if (!force && !stale(given.get().until, now)) return;
  const sandbox = await ctx.getSandbox(environment);
  const [{ getToken }, { getVercelOidcToken }] = await Promise.all([import("@vercel/connect"), import("@vercel/oidc")]);
  const [gateway, boardToken, github] = await Promise.all([
    getVercelOidcToken(),
    getVercelOidcToken({ audience: BOARD }),
    getToken(CONNECTOR, { subject: { type: "app" }, validityBufferMs: GITHUB_MS }),
  ]);
  const tokens = { gateway, board: boardToken, github };
  await sandbox.setNetworkPolicy(policy(board.thread, tokens, process.env.VERCEL_AUTOMATION_BYPASS_SECRET) as SandboxNetworkPolicy);
  const git = await sandbox.run({
    command: `git config --global user.name ${JSON.stringify(eveName(board.thread))} && git config --global user.email ${GIT_EMAIL}`,
  });
  if (git.exitCode !== 0) throw new Error(`git config failed: ${git.stderr.slice(-300)}`);
  given.update((s) => ({ ...s, until: Math.min(expiresAt(gateway), expiresAt(boardToken), now + GITHUB_MS) }));
}

/**
 * Runs `run` with no credentials in the sandbox's policy, for code a PR controls: its install, lifecycle
 * scripts and checks could otherwise call GitHub as the factory App and the board as Eve. `give` leaves
 * them off meanwhile (a parallel bash call's refresh, too), and they're back once `run` settles.
 */
export async function withoutCredentials<T>(ctx: Pick<ToolContext, "getSandbox">, board: Board, run: () => PromiseLike<T>): Promise<T> {
  const sandbox = await ctx.getSandbox(environment);
  given.update((s) => ({ ...s, off: true }));
  try {
    await sandbox.setNetworkPolicy(UNTRUSTED as SandboxNetworkPolicy);
    return await run();
  } finally {
    given.update(() => ({ until: 0, off: false }));
    await give(ctx, board, { force: true });
  }
}
