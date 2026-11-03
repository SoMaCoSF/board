// Who the agent is on the board, and where the board is.

/** Its name on the board: the profile it posts under, and what people @mention. */
export const NAME = "factory";

/** A PNG: Slack won't use the board's SVG avatars as a message's icon. */
export const AVATAR = `https://vercel.com/api/www/avatar?s=64&format=png&u=${NAME}`;

/** Each thread has its own session, which posts with this as its board session, so watchers can tell it from anyone else. */
export const session = (thread: string) => `thread-${thread}`;

/**
 * This factory's production board, the only one the sandbox can reach. Locally, the dev server's:
 * `BOARD_URL`, as for vb, or Next's default port. Not `PORT`, which in eve's dev process is eve's own.
 */
export const BOARD = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/board`
  : process.env.BOARD_URL || "http://localhost:3000/api/board";

/** This factory's own repo, which it changes when it's asked to improve itself: the board's, from the deployment. */
export { OWN_REPO } from "../../app/api/board/[[...path]]/connectors.ts";

type Author = { principal: string; profile: string | null; session: string | null; actor?: string };

/**
 * Whether the agent working on `thread` wrote a message. Anyone who can write may send a profile and a
 * session, so on Vercel only the production deployment's token, which the agent's requests carry, says
 * it's the agent. Locally, the dev server is yours.
 */
export function byAgent(thread: string, by: Author): boolean {
  if (by.profile !== NAME || by.session !== session(thread)) return false;
  const project = process.env.VERCEL_PROJECT_ID;
  return project ? by.principal === `vercel:project:${project}:production` : !process.env.VERCEL_ENV;
}

/** The board routes the agent calls. Never `/webhooks/*`, where the board's token could forge Slack and GitHub events. */
export const VB_ROUTES = `^${new URL(BOARD).pathname}(/(${[
  "me",
  "channels",
  "actors",
  "threads",
  "events",
  "messages(/[0-9]+(/(edit|delete|reactions|labels|sync|typing))?)?",
  "links",
  "schedules(/s?[0-9]+/cancel)?",
  "attachments(/uploads)?(/[A-Za-z0-9_-]+)?",
].join("|")}))?/?$`;

/** Who the agent working on `thread` is on the board, with its token: what its requests carry. */
export function headers(thread: string, token: string, bypass: string | undefined): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-board-profile": NAME,
    "x-board-avatar": AVATAR,
    "x-board-session": session(thread),
    ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
  };
}
