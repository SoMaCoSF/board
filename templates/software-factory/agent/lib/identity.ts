import { ownRepo } from "../../lib/github.ts";
import { projectName } from "../../lib/project.ts";

// Who the agent is on the board: this deployment, writing as itself. It has no profile of its own,
// so the board, and Slack, show it by its Vercel project's name and not as a name "via" that project.

/** Its name on the board, and what people @mention: the Vercel project's. */
export const NAME = projectName();

/** This factory's own repo, which it changes when it's asked to improve itself. */
export const OWN_REPO = ownRepo();

/** This deployment's own origin: its URL on Vercel, the dev server's locally. Not `PORT` under eve, whose dev process has its own. */
export const ORIGIN = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT ?? 3000}`;

/**
 * This deployment's OIDC token on Vercel, and none on your machine. It's what the deployment calls
 * itself with: Deployment Protection's Trusted Sources let a project reach its own environment with
 * it, in `x-vercel-trusted-oidc-idp-token`, and no other.
 */
export const ownToken = async (): Promise<string | null> => (process.env.VERCEL_URL ? (await import("@vercel/oidc")).getVercelOidcToken() : null);

type Author = { principal: string; profile: string | null };

/** The watcher's ID (`factory.ts` names its watcher by it), which the board has it write under. */
export const WATCHER = "wake";

/**
 * The profile this factory's own page writes under, when someone asks the factory something through
 * it: wherever a message shows who wrote it, it reads `launcher via <project>`, and not as the agent
 * asking itself.
 */
export const LAUNCHER = "launcher";

/**
 * The profiles the agent writes under: `factory`, as it wrote at first, and what a project's
 * BOARD_PROFILE says. Nothing else the deployment writes is the agent's, so the factory's page refuses
 * to write under these.
 */
export const agentProfiles = (): string[] => ["factory", ...(process.env.BOARD_PROFILE ? [process.env.BOARD_PROFILE.toLowerCase()] : [])];

/**
 * Whether the agent wrote a message, or reacted: this deployment (`principal`, which its watcher
 * reads from the board), as itself. That's under no profile, as it writes now, or under one of
 * `agentProfiles`. Anything else the deployment writes is someone else's: its watcher's replies
 * (`wake`), what someone asked through its page (`launcher`, or `<name>`), and what its sync brings in
 * from GitHub and Slack, under a platform's profile of who wrote it there (`slack:user:U0456`).
 */
export const byAgent = (by: Author, principal: string): boolean =>
  by.principal === principal && (by.profile === null || agentProfiles().includes(by.profile.toLowerCase()));
