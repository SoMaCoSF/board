import type { Watcher } from "vboard";
import { bot, byFactory, github, prNumber, type GitHubOptions } from "./github.ts";

/** The board thread a factory PR was built for, from its `pi/<thread>` branch (`pi/1559`, `pi/1559-vercel-logs`). */
export const threadOfBranch = (ref: unknown) => {
  const match = typeof ref === "string" ? /^pi\/([1-9]\d*)(?:-|$)/.exec(ref) : null;
  return match ? Number(match[1]) : null;
};

/**
 * Labels a factory PR's thread with its owner, the person who opened the board thread the PR
 * was built for: `owner=<actor>` and `owner.name=<name>`. The Slack renderer shows them on the
 * PR's root, so a PR the factory bot opened says whose it is. PRs from other branches, or that the
 * factory didn't open, are skipped: their author already shows.
 */
export function owner(options: GitHubOptions = {}): Watcher {
  return {
    tail: "dev --label pr",
    run: async ({ event, board }) => {
      const root = event.message;
      if (event.type !== "message.posted" || !root || root.re !== null || root.labels.owner) return;
      const number = prNumber(root.labels);
      if (!number) return;
      const api = await github(options);
      const pr = await api(`/pulls/${number}`);
      const source = threadOfBranch(pr.head?.ref);
      if (!source || !byFactory(pr, (await bot(api)).login)) return;
      const { message } = await board.thread(source);
      const name = message.author?.name ?? message.author?.handle ?? message.by.actor;
      await board.label(root.id, { set: { owner: message.by.actor, "owner.name": name } });
    },
  };
}
