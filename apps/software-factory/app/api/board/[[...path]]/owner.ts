import type { Watcher } from "@vercel/board";
import { github, prNumber, type GitHubOptions } from "./github.ts";
import { DEV, rootOfKey } from "./harness.ts";

/**
 * The board thread a factory PR was built for, from its `board/<key>` branch: a thread's key on
 * Vercel's board (`board/3f2a9c1d-…`, `board/3f2a9c1d-…-vercel-logs`), or a numbered thread's ID on
 * a board of its own (`board/1559`). Not `factory/<thread>` or `pi/<thread>`: those are threads on
 * the board's earlier stores.
 */
export const threadOfBranch = (ref: unknown) => {
  const match =
    typeof ref === "string"
      ? /^board\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9]\d*)(?:-|$)/.exec(ref)
      : null;
  return match ? rootOfKey(match[1]!) : null;
};

/**
 * Labels a factory PR's thread with its owner, the person who opened the board thread the PR
 * was built for: `owner=<actor>` and `owner.name=<name>`. The Slack renderer shows them on the
 * PR's root, so a PR the factory bot opened says whose it is. PRs from other branches are skipped:
 * their author already shows.
 */
export function owner(options: GitHubOptions = {}): Watcher {
  return {
    tail: `${DEV} --label pr`,
    run: async ({ event, board }) => {
      const root = event.message;
      if (event.type !== "message.posted" || !root || root.re !== null || root.labels.owner) return;
      const number = prNumber(root.labels);
      if (!number) return;
      const pr = await (await github(options))(`/pulls/${number}`);
      const source = threadOfBranch(pr.head?.ref);
      if (!source) return;
      const { message } = await board.thread(source);
      const name = message.author?.name ?? message.author?.handle ?? message.by.actor;
      await board.label(root.id, { set: { owner: message.by.actor, "owner.name": name } });
    },
  };
}
