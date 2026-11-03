import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { GITHUB, githubScope, threadRepos } from "../../app/api/board/[[...path]]/connectors";
import { environment } from "../sandbox";
import type { BoardTask } from "./board";
import { BOARD, LOCAL_BOARD, NAME, VB_ROUTES, headers } from "./identity";
import { expiresAt, stale } from "./tokens";
import { agentBoard } from "./vb-tool";

// Real credentials go in the sandbox's network policy, swapped in on the way out, never in the sandbox.
// Anything the sandbox runs can use them while they're there, so each is the least the thread needs.

const GITHUB_MS = 30 * 60_000;
const GIT_EMAIL = `${NAME}@users.noreply.github.com`;

/**
 * The real credentials on the way out, and who the agent is on the board. Without a GitHub token (no
 * connector yet, or no repo for this thread), GitHub gets none, and the agent still works on the board.
 */
export function policy(thread: string, tokens: { gateway: string; board: string; github: string | null }, bypass: string | undefined): NetworkPolicy {
  const github: Record<string, NetworkPolicyRule[]> = tokens.github
    ? {
        "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${tokens.github}` } }] }],
        "github.com": [{ transform: [{ headers: { authorization: `Basic ${Buffer.from(`x-access-token:${tokens.github}`).toString("base64")}` } }] }],
      }
    : {};
  return {
    allow: {
      "ai-gateway.vercel.sh": [
        { transform: [{ headers: { "x-api-key": tokens.gateway, authorization: `Bearer ${tokens.gateway}` } }] },
      ],
      // A board on this machine is out of the sandbox's reach: the vb tool, in the function, talks to it.
      ...(LOCAL_BOARD
        ? {}
        : {
            [new URL(BOARD).hostname]: [
              { match: { path: { regex: VB_ROUTES } }, transform: [{ headers: headers(thread, tokens.board, bypass) }] },
            ],
          }),
      ...github,
      "*": [],
    },
  };
}

/**
 * A GitHub token for this thread's repos only (`threadRepos`): code run from one repo's PR can't reach
 * the app's other repos. Null when there's no repo to scope it to, or no connector yet.
 */
async function githubToken(getToken: typeof import("@vercel/connect").getToken, thread: string, boardToken: string, bypass: string | undefined) {
  const root = await agentBoard(thread, { token: async () => boardToken, bypass })
    .thread(thread)
    .then((view) => view.message)
    .catch(() => null);
  const repos = threadRepos(root ?? { labels: {} });
  const scope = githubScope(repos);
  if (!scope) {
    console.warn(`[factory] no repo to scope a GitHub token to for thread ${thread} (REPOS in connectors.ts), so the agent can't reach GitHub this turn`);
    return null;
  }
  return getToken(GITHUB, { subject: { type: "app" }, validityBufferMs: GITHUB_MS, authorizationDetails: scope }).catch((error: unknown) => {
    console.warn(`[factory] no GitHub token from ${GITHUB} for ${repos.join(", ")}, so the agent can't reach GitHub this turn:`, error);
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
  const [gateway, boardToken] = await Promise.all([getVercelOidcToken(), getVercelOidcToken({ audience: BOARD })]);
  const github = await githubToken(getToken, board.thread, boardToken, bypass);
  await sandbox.setNetworkPolicy(policy(board.thread, { gateway, board: boardToken, github }, bypass) as SandboxNetworkPolicy);
  const git = await sandbox.run({
    command: `git config --global user.name ${JSON.stringify(NAME)} && git config --global user.email ${GIT_EMAIL}`,
  });
  if (git.exitCode !== 0) throw new Error(`git config failed: ${git.stderr.slice(-300)}`);
  // Without GitHub, the next turn's start asks again: the connector may be set up by then.
  given.update(() => ({ until: Math.min(expiresAt(gateway), expiresAt(boardToken), ...(github ? [now + GITHUB_MS] : [])) }));
}
