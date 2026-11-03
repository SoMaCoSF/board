import type { SyncFn } from "@vercel/board/sync";
import type { GitHubEvent } from "@vercel/board/sync-github";

/**
 * Every repo the GitHub App is installed on comes into `channel`, and nothing goes back: what's
 * said on the board stays there, so a conversation about a PR doesn't end up as comments on it
 * (the agent comments on GitHub on purpose, with gh). Inline review threads stay on the board,
 * out of Slack. A function of our own, not `repos()`, keeps every repo's events, so installing
 * the app on a repo is all it takes to add one.
 */
export function fromGitHub(channel: string): SyncFn<GitHubEvent> {
  return async (sync) => {
    if (sync.direction !== "in") return;
    await sync.import(channel, { noSync: sync.event.subthread !== null });
  };
}
