import { board, type Board } from "@vercel/board";

/** The channel campaigns live in: one thread per campaign there, and each campaign's tasks in a channel under it. */
export const ROOT = (process.env.CAMPAIGN_CHANNEL ?? "migrate").replace(/\/+$/, "");

/** The channel a campaign's tasks are in. */
export const tasksChannel = (slug: string) => `${ROOT}/${slug}`;

/** What the board calls an agent: `worker-3`, a profile of this project. */
export const workerName = (n: number) => `worker-${n}`;

/**
 * Which of the team's boards this is: the one CAMPAIGN_BOARD names, or in production the team's
 * default. Anything else, your dev server included, is on one named `campaign-dev`, which its
 * first use makes, so nothing you try shows up where your team works.
 */
export const boardName = process.env.CAMPAIGN_BOARD || (process.env.VERCEL_ENV === "production" ? null : "campaign-dev");

let handle: Board | undefined;

/**
 * The team's board in Vercel's API, or the one at BOARD_URL, which `vb serve` prints. Made on
 * first use, so a build with no board to reach still builds. It acts as this project, whoever is
 * looking at the page.
 */
export const team = (): Board => (handle ??= board(boardName && !process.env.BOARD_URL?.trim() ? { name: boardName } : {}));
