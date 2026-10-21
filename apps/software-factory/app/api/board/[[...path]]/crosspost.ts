import type { Watcher } from "vboard";
import { sourceLink } from "./agent.ts";
import { github, prNumber, type GitHubOptions } from "./github.ts";
import { threadOfBranch } from "./owner.ts";

/** The watcher's ID, and so its actor: Pi isn't woken by its replies, and Slack shows them without a label. */
export const CROSSPOST = "crosspost";
export const CROSSPOST_ACTOR = `vboard:watch:${CROSSPOST}`;

/**
 * Links a factory PR's Slack thread and the Slack thread it was built for, both ways, once the
 * PR's root lands in Slack: the PR thread gets `:crosspost: From <who>'s thread`, and the source
 * thread gets `:crosspost: #12 <title>`, each a link to the other. Only `pi/<thread>` PRs whose
 * source thread came from Slack, once per PR root.
 */
export function crosspost(options: GitHubOptions = {}): Watcher {
  return {
    // `--all`: where the PR root landed in Slack only shows in its delivery receipt.
    tail: "dev --label pr --all",
    run: async ({ event, board, once }) => {
      const root = event.message;
      // Roots linked before `once` wear `crosspost=yes` instead of a record: a state edit's receipt would link them again.
      if (event.type !== "message.synced" || !root || root.re !== null || root.labels.crosspost) return;
      const here = sourceLink({ thread: event.payload.external.thread });
      if (here?.platform !== "Slack") return;
      const number = prNumber(root.labels);
      if (!number) return;
      // The root syncs again on every state edit; its receipts run on its thread's lane, one at a time.
      await once(`crosspost:${root.id}`, async () => {
        const pr = await (await github(options))(`/pulls/${number}`);
        const sourceId = threadOfBranch(pr.head?.ref);
        if (!sourceId) return;
        const { message: source } = await board.thread(sourceId);
        const there = sourceLink(source.origin);
        if (there?.platform !== "Slack") return;
        const who = source.author?.name ?? source.author?.handle;
        const title = (/^PR #\d+: (.+)/.exec(root.text)?.[1] ?? pr.title ?? "").replace(/[[\]]/g, "\\$&");
        await board.reply(root.id, `:crosspost: From [${who ? `${who}'s` : "its"} Slack thread](${there.url}) · board #${source.id}`);
        await board.reply(source.id, `:crosspost: [#${number} ${title}](${here.url})`);
      });
    },
  };
}
