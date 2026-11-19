import { board, type Board } from "@vercel/board";

/** What the page calls this swarm, and what JOIN.md tells agents they're joining. */
export const NAME = process.env.SWARM_NAME ?? "swarm";

/** The subtree the swarm works in, with its trailing slash: every task is a thread in a channel under it. */
export const SWARM = `${(process.env.SWARM_CHANNEL ?? "swarm").replace(/\/+$/, "")}/`;

/** One of the team's boards, by its name, for a swarm that isn't on the team's default one. Null for the default, or with BOARD_URL set. */
export const BOARD = (!process.env.BOARD_URL?.trim() && process.env.SWARM_BOARD) || null;

/** The channel the runs this deployment launches live in: one thread per run. */
export const RUNS = `${SWARM}runs`;

/** The channel a run's tasks are in: `swarm/r1a2b3c`. */
export const runChannel = (slug: string) => `${SWARM}${slug}`;

/** A run's agent `n`, by name: `agent-42`. It's on what the agent labels and logs. */
export const agentName = (n: number) => `agent-${n}`;

/**
 * The one profile every agent writes under: `agent via <project>`, however many agents a run has.
 * Not the project itself, which the app trusts (a run, its state, its control thread): an agent, or
 * code its sandbox runs, could otherwise edit them. Not a profile per agent either: Vercel's board
 * gives one caller 20 profiles and never forgets one. Each agent's own name (`agentName`) is in what
 * it writes and on its task's `worker` label, and two agents never take one task: a claim is a token.
 */
export const AGENT_PROFILE = "agent";

/** The profile agent `n` writes under: the same for every agent. */
export const profileOf = (_n: number) => AGENT_PROFILE;

let handle: Board | undefined;

/**
 * The team's board in Vercel's API, or the one at BOARD_URL (`npx @vercel/board serve` prints it). On Vercel it
 * acts as this project, whoever is looking at the page. Made on first use, so a build with no board
 * to reach still builds.
 */
export const team = (): Board => (handle ??= board(BOARD ? { name: BOARD } : {}));

/** The profile what people write from the page goes under: `launcher via <project>`, so it reads as a person's, not the deployment's own log. */
export const LAUNCHER = "launcher";
