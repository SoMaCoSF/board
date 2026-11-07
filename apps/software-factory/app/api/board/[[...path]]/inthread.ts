import type { Watcher } from "@vercel/board";
import { mirror, type SyncFn } from "@vercel/board/sync";
import { REPO } from "./github.ts";
import { threadOfBranch } from "./owner.ts";
import { DEV } from "./harness.ts";

// A factory PR has its own Slack thread, like any PR, where its review happens. The thread it
// was built for also gets the PR's one-line message as a reply, which follows the PR's state.

/** The watcher's ID, and so its actor: Eve isn't woken by its replies. */
export const IN_THREAD = "in-thread";

/** A PR's state as the workspace's PR emoji, without colons. */
export const STATE_EMOJI: Record<string, string> = {
  open: "pr",
  draft: "pr-draft",
  merged: "pr-merged",
  closed: "pr-closed",
};

/**
 * The board thread a GitHub PR event's PR was built for, from its `board/<thread>` branch in
 * this repo (a fork's branch names nothing here), or null.
 */
export function sourceOfPr(raw: unknown): string | null {
  const head = (raw as { pull_request?: { head?: { ref?: unknown; repo?: { full_name?: unknown } | null } } } | null)
    ?.pull_request?.head;
  if (head?.repo?.full_name !== REPO) return null;
  return threadOfBranch(head.ref);
}

/**
 * The PR thread a reaction's message stands for: a PR thread's root, or a factory PR's message in
 * its source thread (labeled `pr.thread`, the PR thread's root). Null for any other message.
 */
export const prThreadOf = (message: { id: string; re: string | null; labels: Record<string, string> } | undefined) =>
  !message ? null : message.re === null ? message.id : (message.labels["pr.thread"] ?? null);

/** Whether a board message is a factory PR's root built for another thread (labeled `source`). */
export const isFactoryPrRoot = (message: { re: string | null; labels: Record<string, string> }) =>
  message.re === null && !!message.labels.pr && !!message.labels.source;

/** Slack's side of `vboard/dev`: every new root starts a thread in the channel, a factory PR's too, so its review happens there. */
export const devMirror = (channel = DEV): SyncFn => mirror(channel);

/**
 * Posts a factory PR's message in its source thread once its root is on the board, and keeps it
 * in step with the PR's state. The message is labeled with the PR
 * (`pr`, `state`, and `pr.thread`, the PR thread's root), so :shipit: and :security: on it act on
 * that PR, and the renderer shows it as the PR's one line. The PR root is labeled `card=<id>`.
 */
export function inThread(): Watcher {
  return {
    tail: `${DEV} --label pr`,
    run: async ({ event, board }) => {
      if (!["message.posted", "labels.changed", "message.edited"].includes(event.type)) return;
      if (!event.message || !isFactoryPrRoot(event.message)) return;
      // The root as it is now, not as it was at this event: a state change or retitle logged before
      // the line's `card` label still reaches the line.
      const root = (await board.thread(event.message.id)).message;
      if (root.deleted) return;
      const source = root.labels.source!;
      const state = root.labels.state ?? "open";
      const card = root.labels.card;
      if (!card) {
        const posted = await board.reply(source, {
          text: root.text,
          labels: { pr: root.labels.pr!, state, "pr.thread": root.id },
          id: `pr-card-${root.id}`,
        });
        await board.label(root.id, { set: { card: posted.id } });
        return;
      }
      if (event.type === "labels.changed" && "state" in ((event.payload as { set?: object }).set ?? {})) {
        await board.label(card, { set: { state } });
      } else if (event.type === "message.edited") {
        await board.edit(card, root.text);
      }
    },
  };
}
