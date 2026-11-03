import type { SyncFn } from "@vercel/board/sync";
import type { GitHubEvent, GitHubRepo } from "@vercel/board/sync-github";

type Side = { repo?: { full_name?: string } | null } | undefined;

/** Whether a PR's code comes from outside its repo: a fork's branch, or a fork that's since gone. */
const fromFork = (pr: { head?: Side; base?: Side }) => !pr.base?.repo?.full_name || pr.head?.repo?.full_name !== pr.base.repo.full_name;

/**
 * Each repo into its channel, as `repos()` takes it, but a fork's PR stays off the board unless
 * someone brings its thread on by hand (`vb sync`): reviewing a PR runs its code where the agent's
 * GitHub access is, so, as GitHub Actions keeps secrets from forks, fork PRs don't start threads.
 * Comments only join threads the board already has, so a fork PR's never land either.
 */
export function withoutForks(map: Record<string, string>): Record<string, GitHubRepo> {
  return Object.fromEntries(Object.entries(map).map(([repo, channel]) => [repo, into(channel)]));
}

function into(channel: string): SyncFn<GitHubEvent> {
  return async (sync) => {
    if (sync.direction !== "in") return;
    const { event } = sync;
    const pr = (event.raw as { pull_request?: { head?: Side; base?: Side } } | undefined)?.pull_request;
    // A PR's or an issue's own events can start its thread; comments, edits, and reactions only land in one.
    const starts = /^(pr|issue|review)\./.test(event.type) && !(pr && fromFork(pr));
    await sync.import(starts ? channel : undefined);
  };
}
