import type { SyncFn } from "@vercel/board/sync";
import type { GitHubEvent, GitHubRepo } from "@vercel/board/sync-github";

type Side = { repo?: { full_name?: string } | null } | undefined;

/** A fork's branch, or a fork that's since gone. */
const fromFork = (pr: { head?: Side; base?: Side }) => !pr.base?.repo?.full_name || pr.head?.repo?.full_name !== pr.base.repo.full_name;

/**
 * `repos()`'s map, but a fork's PR starts no thread: reviewing it runs its code where the agent's
 * GitHub token is. Comments, edits, and reactions only join threads that exist, so a fork PR's
 * don't land either.
 */
export function withoutForks(map: Record<string, string>): Record<string, GitHubRepo> {
  return Object.fromEntries(Object.entries(map).map(([repo, channel]) => [repo, intoUnlessFork(channel)]));
}

/** Like `into()` from `@vercel/board/sync`, which imports everything. */
function intoUnlessFork(channel: string): SyncFn<GitHubEvent> {
  return async (sync) => {
    if (sync.direction !== "in") return;
    const pr = (sync.event.raw as { pull_request?: { head?: Side; base?: Side } } | undefined)?.pull_request;
    const starts = /^(pr|issue|review)\./.test(sync.event.type) && !(pr && fromFork(pr));
    await sync.import(starts ? channel : undefined);
  };
}
