import { REPO } from "./github.ts";
import { DEV } from "./harness.ts";
import { sourceOfPr } from "./inthread.ts";

// What the factory imports from GitHub but keeps on the board, out of Slack, or off the board altogether.

type GitHubEvent = { kind: string; thread: string; subthread: string | null; type: string; labels?: Record<string, string>; raw?: unknown };
type Board = {
  messages(query: { channel: string; label: Record<string, string>; limit: number }): Promise<{ messages: unknown[] }>;
  thread(id: string): Promise<{ message: { re: string | null; channel: string; noSync: boolean; deleted: boolean; labels: Record<string, string> } }>;
};

/**
 * Whether a GitHub event's board reply stays off Slack: inline review threads (comments on
 * lines of code), and the "closed by …" reply when a PR is closed without merging. Closing
 * a batch of stale PRs posted one Slack reply each; the PR root's emoji turning
 * :pr-closed: still says it. Merges still post "merged by …".
 */
export function boardOnly(event: Pick<GitHubEvent, "subthread" | "type" | "labels">): boolean {
  if (event.subthread !== null) return true;
  return event.type === "pr.closed" && event.labels?.state === "closed";
}

/**
 * Whether a GitHub comment is on a PR the board has no thread for: one opened before the
 * board was, or while it wasn't listening. Syncing it would open a new Slack thread for an
 * old PR (a "closing as stale" comment did, for each PR it closed), so it stays on GitHub.
 * A PR's thread starts when it's opened or marked ready, so new PRs always have one.
 */
export async function unseenPr(event: GitHubEvent, board: Board, channel: string): Promise<boolean> {
  if (event.kind !== "message") return false;
  const number = /:(\d+)$/.exec(event.thread)?.[1];
  if (!number) return false;
  const { messages } = await board.messages({ channel, label: { pr: `${REPO}#${number}` }, limit: 1 });
  return messages.length === 0;
}

/**
 * The thread a new factory PR was built for (`source=<thread>`), which gets the PR's line: its
 * `board/<thread>` branch's thread, when that's a live root in `channel` that syncs to Slack.
 * Null for a PR that already has a root, and for a source that's missing, deleted, elsewhere,
 * kept off Slack, or a factory PR's own root.
 */
export async function sourceThread(event: GitHubEvent, board: Board, channel: string): Promise<string | null> {
  if (event.kind !== "lifecycle") return null;
  const source = sourceOfPr(event.raw);
  const number = /:(\d+)$/.exec(event.thread)?.[1];
  if (!source || !number) return null;
  const { messages } = await board.messages({ channel, label: { pr: `${REPO}#${number}` }, limit: 1 });
  if (messages.length) return null;
  // A missing thread is a 404; anything else throws, so the import is retried.
  const root = await board.thread(source).then(
    (thread) => thread.message,
    (error: { status?: number }) => {
      if (error?.status === 404) return null;
      throw error;
    },
  );
  // A PR root built for another thread doesn't get lines of its own.
  const shown = root && root.re === null && root.channel === channel && !root.noSync && !root.deleted && !root.labels.source;
  return shown ? source : null;
}

// Going out, a function gets a delivery it never calls: nothing written on the board or in Slack reaches GitHub.
type Outbound = { direction: "out"; deliver(): Promise<void> };
type PullsSync =
  | { direction: "in"; event: GitHubEvent; board: Board; import(channel: string, overrides: { noSync: boolean; labels?: Record<string, string> }): Promise<unknown> }
  | Outbound;
type IssuesSync = { direction: "in"; import(channel: string): Promise<unknown> } | Outbound;

/**
 * PR threads come in from GitHub and go nowhere back: a reply on the board, an Eve's included, stays
 * in Slack and on the board, so a conversation about a PR doesn't end up as comments on it.
 * Inline review threads and "closed by …" replies stay out of Slack; comments on a PR the board
 * has no thread for stay on GitHub. A factory PR's root (its branch is `board/<thread>`) is labeled
 * `source=<thread>`, so that thread gets the PR's line too (`inthread.ts`).
 */
export async function pulls(sync: PullsSync): Promise<void> {
  if (sync.direction === "out") return;
  if (await unseenPr(sync.event, sync.board, DEV)) return;
  const source = await sourceThread(sync.event, sync.board, DEV);
  await sync.import(DEV, { noSync: boardOnly(sync.event), ...(source ? { labels: { source } } : {}) });
}

/**
 * Issue threads come in from GitHub and go nowhere back, like PR threads: a public repo would show
 * what's said on the board. Eve answers on GitHub only on purpose, with gh.
 */
export async function issues(sync: IssuesSync): Promise<void> {
  if (sync.direction === "in") await sync.import(DEV);
}
