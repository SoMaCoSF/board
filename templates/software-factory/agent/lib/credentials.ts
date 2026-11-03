import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { defineState } from "eve/context";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { connectors, GITHUB, VERCEL_SUBJECT, VERCEL_TOKEN_ENV } from "../../app/api/board/[[...path]]/connectors";
import { environment } from "../sandbox";
import type { BoardTask } from "./board";
import { BOARD, LOCAL_BOARD, NAME, VB_ROUTES, headers } from "./identity";
import { expiresAt, stale } from "./tokens";

// Real credentials go in the sandbox's network policy, swapped in on the way out, never in the sandbox.

const GITHUB_MS = 30 * 60_000;
const GIT_EMAIL = `${NAME}@users.noreply.github.com`;

/** Where the Vercel CLI keeps its settings on Linux: its current team among them. */
const VERCEL_CONFIG = "$HOME/.local/share/com.vercel.cli";

const bearer = (token: string): NetworkPolicyRule[] => [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }];

/**
 * The real credentials on the way out, and who the agent is on the board. Without a GitHub token (no
 * connector yet), GitHub gets none, and the agent still works on the board; without a Vercel token,
 * the `vercel` CLI gets none.
 */
export function policy(
  thread: string,
  tokens: { gateway: string; board: string; github: string | null; vercel: string | null },
  bypass: string | undefined,
): NetworkPolicy {
  const github: Record<string, NetworkPolicyRule[]> = tokens.github
    ? {
        "api.github.com": bearer(tokens.github),
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
      ...(tokens.vercel ? { "api.vercel.com": bearer(tokens.vercel) } : {}),
      "*": [],
    },
  };
}

/**
 * The agent's `vercel` CLI token: a team token in the environment, or the account someone connected
 * through Connect's Vercel connector on the setup page. Null when there's neither.
 */
async function vercelToken(getTokenResponse: typeof import("@vercel/connect").getTokenResponse) {
  const team = process.env[VERCEL_TOKEN_ENV];
  if (team) return { token: team, until: Number.POSITIVE_INFINITY };
  const connected = await getTokenResponse(connectors().vercel, { subject: VERCEL_SUBJECT, validityBufferMs: GITHUB_MS }).catch(() => null);
  return connected ? { token: connected.token, until: connected.expiresAt } : null;
}

/** The team a token's claims name, by ID. */
const teamOf = (jwt: string): string | null => {
  const owner = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).owner_id;
  return typeof owner === "string" && /^team_[A-Za-z0-9]+$/.test(owner) ? owner : null;
};

const given = defineState("factory.credentials", () => ({ until: 0 }));

/** Puts fresh tokens and git's identity in the sandbox: always with `force` (each turn's start, which also covers a sandbox eve recreated), else when they're near their end. */
export async function give(ctx: Pick<ToolContext, "getSandbox">, board: BoardTask, { force = false } = {}) {
  const now = Date.now();
  if (!force && !stale(given.get().until, now)) return;
  const sandbox = await ctx.getSandbox(environment);
  const [{ getToken, getTokenResponse }, { getVercelOidcToken }] = await Promise.all([import("@vercel/connect"), import("@vercel/oidc")]);
  const [gateway, boardToken, github, vercel] = await Promise.all([
    getVercelOidcToken(),
    getVercelOidcToken({ audience: BOARD }),
    getToken(GITHUB, { subject: { type: "app" }, validityBufferMs: GITHUB_MS }).catch((error: unknown) => {
      console.warn(`[factory] no GitHub token from ${GITHUB}, so the agent can't reach GitHub this turn:`, error);
      return null;
    }),
    vercelToken(getTokenResponse),
  ]);
  const tokens = { gateway, board: boardToken, github, vercel: vercel?.token ?? null };
  await sandbox.setNetworkPolicy(policy(board.thread, tokens, process.env.VERCEL_AUTOMATION_BYPASS_SECRET) as SandboxNetworkPolicy);
  // git's identity, and the Vercel CLI's team: this factory's, so `vercel` works on it without --scope.
  const team = vercel ? teamOf(gateway) : null;
  const setup = [
    `git config --global user.name ${JSON.stringify(NAME)}`,
    `git config --global user.email ${GIT_EMAIL}`,
    ...(team ? [`mkdir -p "${VERCEL_CONFIG}"`, `printf '{"currentTeam":"%s"}' ${team} > "${VERCEL_CONFIG}/config.json"`] : []),
  ].join(" && ");
  const configured = await sandbox.run({ command: setup });
  if (configured.exitCode !== 0) throw new Error(`sandbox setup failed: ${configured.stderr.slice(-300)}`);
  // Without GitHub, the next turn's start asks again: the connector may be set up by then.
  given.update(() => ({
    until: Math.min(expiresAt(gateway), expiresAt(boardToken), ...(github ? [now + GITHUB_MS] : []), vercel?.until ?? Number.POSITIVE_INFINITY),
  }));
}
