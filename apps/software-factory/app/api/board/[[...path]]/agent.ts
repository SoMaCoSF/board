import type { WatcherContext } from "@vercel/board";
import { eveName, eveSession, type Task } from "./harness.ts";
import { sendToEve, type EveMessage } from "./eve.ts";

export { INSTRUCTIONS, eveAvatar, eveName, evePreview, policy, type Task } from "./harness.ts";


/**
 * The environment whose deployment this one's Eves write as: a preview's, on its own board, or
 * production's everywhere else, so a preview can never pass for production's Eve there.
 */
const eveEnvironment = () => (process.env.VERCEL_ENV === "preview" ? "preview" : "production");

/**
 * Whether a message was written by the Eve working on `thread` . Every Eve posts as the factory's deployment
 * (production's, or a preview's on the previews' board), with its OIDC token; its profile and session
 * are headers anyone who can write may send, so they only say which thread's Eve it is.
 */
export const byEve = (thread: string, by: { principal: string; profile: string | null; session: string | null }) =>
  !!process.env.VERCEL_PROJECT_ID &&
  by.principal === `vercel:project:${process.env.VERCEL_PROJECT_ID}:${eveEnvironment()}` &&
  by.profile === eveName(thread) &&
  by.session === eveSession(thread);

/**
 * The platform user a message is by, when a sync imported it: `slack:user:U0456` is user `user:U0456` under sync key
 * `slack`. On Vercel's board that's the importing project's profile (`vercel:project:prj_…:production+slack:user:U0456`);
 * on a board of its own, and from an API that names the platform user alone, it's the principal. Null for anyone
 * else: an agent's or a watcher's profile never has a colon.
 */
export function platformUser(by: { principal: string; profile?: string | null }): { key: string; user: string } | null {
  const id = by.profile?.includes(":") ? by.profile : by.profile == null && !/^(vercel|board):/.test(by.principal) ? by.principal : null;
  const colon = id?.indexOf(":") ?? -1;
  return id && colon > 0 ? { key: id.slice(0, colon), user: id.slice(colon + 1) } : null;
}

/**
 * Whether a message is one of the board's watchers' own notes (a crosspost, `:security:`'s answer, or saying Eve
 * couldn't start), not a person's: it doesn't wake Eve or triage. On Vercel's board a watcher writes as this
 * deployment's project, under its ID as a profile and with no session, which every Eve has; on a board of its own,
 * as `board:watch:<id>`. What the factory's sync imports is by its project with no session too, under the platform
 * user as a profile: that's a person's, not a watcher's.
 */
export const byWatcher = (by: { actor: string; principal: string; profile: string | null; session: string | null }) =>
  by.actor.startsWith("board:watch:") ||
  (!!process.env.VERCEL_PROJECT_ID &&
    by.principal.startsWith(`vercel:project:${process.env.VERCEL_PROJECT_ID}:`) &&
    by.session === null &&
    platformUser(by) === null);

/**
 * Whether a message was written by an agent profile (someone's coding agent, like `julian/claude`, or an Eve), not
 * a person: a coding agent sharing its progress in `dev` shouldn't get a kind, and with it, Eve. A platform user a
 * sync imported has a profile too, and is a person.
 */
export const byAgent = (by: { principal: string; profile: string | null }) => by.profile !== null && platformUser(by) === null;

/**
 * Whether a message's author is a bot account on its platform (Vercel's deploy comments, CI): `vercel[bot]` as
 * GitHub names it, or `vboard-factory/vercel-bot`, the handle Vercel's board gives one a sync imported.
 */
export const byBot = (author: { handle: string; name?: string } | null | undefined) =>
  !!author && (author.handle.endsWith("[bot]") || !!author.name?.endsWith("[bot]") || /\/[^/]*-bot$/.test(author.handle));

/** The Slack workspace the factory syncs with. */
const SLACK = "https://vercel.slack.com";

/**
 * Where a thread came from, as a link Eve can put in its PR: a Slack thread's permalink or a GitHub issue or PR.
 * `origin.thread` is the sync target: `slack:C0123:1727000000.123456`, `github:owner/repo:issue:12`, `github:owner/repo:12`.
 */
export function sourceLink(origin: { thread: string } | null | undefined) {
  const thread = origin?.thread ?? "";
  const slack = /^slack:([A-Z0-9]+):(\d+)\.(\d+)$/.exec(thread);
  if (slack) return { platform: "Slack", url: `${SLACK}/archives/${slack[1]}/p${slack[2]}${slack[3]}` };
  const gh = /^github:([^/:]+\/[^/:]+):(issue:)?(\d+)$/.exec(thread);
  if (gh) return { platform: "GitHub", url: `https://github.com/${gh[1]}/${gh[2] ? "issues" : "pull"}/${gh[3]}` };
  return null;
}

/** The task message that starts Eve on a thread, with where it came from when it's synced. */
export function taskMessage(
  task: string,
  thread: { id: string; origin: { thread: string } | null; author?: { name: string } | null },
) {
  const source = sourceLink(thread.origin);
  const by = thread.author?.name ? ` by ${thread.author.name}` : "";
  return `There's ${task} in board thread #${thread.id}${source ? `, posted${by} on ${source.platform}: ${source.url}` : ""}.`;
}


/** How many times a message to Eve is tried before the thread hears Eve couldn't start, and the wait after a first failure. */
const TRIES = 3;
const RETRY_MS = 5_000;

/**
 * Runs `start` until it works, up to TRIES times, and if it never does, says so in the thread instead of throwing.
 * A watcher that throws gets 5 tries in about 15 seconds, then board drops that event without a word in the thread:
 * one bad start (setup hitting GitHub's rate limit) would leave a reply unanswered, with no reason given. Saying so
 * tells the thread, and the next reply tries again.
 */
export async function startOrSay(
  board: Pick<WatcherContext["board"], "reply">,
  thread: string,
  start: () => Promise<void>,
  retryMs = RETRY_MS,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (attempt < TRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
        continue;
      }
      console.error(`[factory] Eve couldn't start on board thread #${thread}:`, error);
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
      await board.reply(thread, `Eve couldn't start: \`${reason}\`. Reply here to try again.`);
      return;
    }
  }
}

export async function tellEve({ board, ...input }: EveMessage & { board: Pick<WatcherContext["board"], "reply"> }) {
  await startOrSay(board, input.thread, () => sendToEve(input));
}
