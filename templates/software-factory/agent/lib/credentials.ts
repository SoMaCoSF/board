import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { githubScope, threadRepos } from "../../lib/github";
import { environment } from "../sandbox";
import type { BoardTask } from "./board";
import { BOARD, NAME } from "./identity";
import { stale } from "./tokens";
import { agentBoard } from "./vb-tool";

// Real credentials go in the sandbox's network policy, which adds them on the way out. Anything the
// sandbox runs can use them, so each is the least the thread needs.

const GITHUB_MS = 30 * 60_000;
const GIT_EMAIL = `${NAME}@users.noreply.github.com`;

/** What the sandbox's requests get on the way out: GitHub, when this thread has a token, and nothing else. */
export function policy(tokens: { github: string | null }): NetworkPolicy {
  const github: Record<string, NetworkPolicyRule[]> = tokens.github
    ? {
        "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${tokens.github}` } }] }],
        "github.com": [{ transform: [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${tokens.github}`).toString("base64")}` } }] }],
      }
    : {};
  return {
    allow: {
      ...github,
      "*": [],
    },
  };
}

/**
 * A GitHub token for this thread's repos only (`threadRepos`), through the connector the board named:
 * code run from one repo's PR can't reach the app's other repos. Null without a repo or a connector.
 */
async function githubToken(getToken: typeof import("@vercel/connect").getToken, board: BoardTask, boardToken: string, bypass: string | undefined) {
  const root = await agentBoard(board.thread, { token: async () => boardToken, bypass })
    .thread(board.thread)
    .then((view) => view.message)
    .catch(() => null);
  if (!root) {
    console.warn(`[factory] couldn't read thread ${board.thread}, so the agent can't reach GitHub this turn`);
    return null;
  }
  const repos = threadRepos(root, board.repos);
  const scope = githubScope(repos);
  if (!scope || !board.github) {
    console.warn(`[factory] no repo to scope a GitHub token to for thread ${board.thread} (repoChannels in the board route), so the agent can't reach GitHub this turn`);
    return null;
  }
  return getToken(board.github, { subject: { type: "app" }, validityBufferMs: GITHUB_MS, authorizationDetails: scope }).catch((error: unknown) => {
    console.warn(`[factory] no GitHub token from ${board.github} for ${repos.join(", ")}, so the agent can't reach GitHub this turn:`, error);
    return null;
  });
}

const given = defineState("factory.credentials", () => ({ until: 0 }));

/** Puts fresh tokens and git's identity in the sandbox: always with `force` (each turn's start, which also covers a sandbox eve recreated), else when they're near their end. */
export async function give(ctx: Pick<ToolContext, "getSandbox">, board: BoardTask, { force = false } = {}) {
  const now = Date.now();
  if (!force && !stale(given.get().until, now)) return;
  const sandbox = await ctx.getSandbox(environment);
  const [{ getToken }, { getVercelOidcToken }] = await Promise.all([import("@vercel/connect"), import("@vercel/oidc")]);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const boardToken = await getVercelOidcToken({ audience: BOARD });
  const github = await githubToken(getToken, board, boardToken, bypass);
  await sandbox.setNetworkPolicy(policy({ github }) as SandboxNetworkPolicy);
  const git = await sandbox.run({
    command: `git config --global user.name ${JSON.stringify(NAME)} && git config --global user.email ${GIT_EMAIL}`,
  });
  if (git.exitCode !== 0) throw new Error(`git config failed: ${git.stderr.slice(-300)}`);
  // Without GitHub, the next turn's start asks again: the connector may be set up by then.
  given.update(() => ({ until: github ? now + GITHUB_MS : Infinity }));
}
