import type { SyncFn } from "@vercel/board/sync";
import type { GitHubEvent, GitHubRepo } from "@vercel/board/sync-github";

type Side = { ref?: string; repo?: { full_name?: string } | null } | undefined;
type PR = { head?: Side; base?: Side };

/** A fork's branch, or a fork that's since gone. */
const fromFork = (pr: PR) => !pr.base?.repo?.full_name || pr.head?.repo?.full_name !== pr.base.repo.full_name;

/** The factory's own: the agent works on factory/<thread> branches. */
const fromFactory = (pr: PR) => pr.head?.ref?.startsWith("factory/") === true;

/**
 * `repos()`'s map, but two kinds of PR start no thread. A fork's, because reviewing it runs its code
 * where the agent's GitHub token is. The factory's own, because the agent follows those itself, from
 * the thread it built them for. Comments, edits, and reactions only join threads that exist, so
 * neither one's land either.
 */
export function withoutForksOrOwn(map: Record<string, string>): Record<string, GitHubRepo> {
  return Object.fromEntries(Object.entries(map).map(([repo, channel]) => [repo, intoUnless(channel)]));
}

/** Like `into()` from `@vercel/board/sync`, which imports everything. */
function intoUnless(channel: string): SyncFn<GitHubEvent> {
  return async (sync) => {
    if (sync.direction !== "in") return;
    const pr = (sync.event.raw as { pull_request?: PR } | undefined)?.pull_request;
    const starts = /^(pr|issue|review)\./.test(sync.event.type) && !(pr && (fromFork(pr) || fromFactory(pr)));
    await sync.import(starts ? channel : undefined);
  };
}
