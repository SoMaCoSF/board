import type { GitHubHandler } from "vboard/sync-github";

// What the factory imports from GitHub but keeps on the board, out of Slack, or off the board altogether.

type GitHubEvent = { subthread: string | null; type: string; labels?: Record<string, string> };

/**
 * Whether a GitHub event's board reply stays off Slack: inline review threads (comments on
 * lines of code), and the "closed by …" reply when a PR is closed without merging. Closing
 * a batch of stale PRs posted one Slack reply each; the PR root's emoji turning
 * :pr-closed: still says it. Merges still post "merged by …".
 */
export function boardOnly(event: GitHubEvent): boolean {
  if (event.subthread !== null) return true;
  return event.type === "pr.closed" && event.labels?.state === "closed";
}

/**
 * Comments on a PR the board has no thread for stay on GitHub: syncing them opened a Slack
 * thread per old PR (a "closing as stale" comment did, for each PR it closed). A PR's thread
 * starts when it's opened or marked ready, so new PRs have one.
 */
export const syncPull: GitHubHandler = async ({ event, board }) => {
  await board.sync("dev", event, { noSync: boardOnly(event), knownThreadsOnly: event.kind === "message" });
};
