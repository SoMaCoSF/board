import { board } from "vboard";
import { http } from "vboard/backend-http";

/** The commit this deployment runs, as its replies say. */
export const COMMIT = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

/** The channel pong answers in. Nothing syncs it, and no factory watcher reads it. */
export const PINGS = "pings";

// A board that keeps no log: the software factory's board keeps it. The factory matches
// `ping`'s tail and wakes this project, which pulls the match and replies as itself. `pings`
// isn't synced anywhere and no factory watcher reads it, so this touches no Slack, GitHub, or
// Pi. A preview's VBOARD_URL points it at a factory preview instead. The route and the page's
// actions share this one handle: the page posts as this project, and the watcher answers.
export const team = board({
  backend: http(process.env.VBOARD_URL ?? "https://vboard-factory.playground-vercel.tools/api/board"),
  // Where it's mounted, so it knows its own URL before its first request: on Vercel, the
  // deployment's own, which the factory wakes at `<url>/wake`.
  basePath: "/api/board",
  watch: {
    ping: {
      tail: PINGS,
      run: async ({ event, board }) => {
        if (event.type !== "message.posted" || event.message?.re !== null) return;
        await board.reply(event.message.id, `pong from ${COMMIT}`);
      },
    },
  },
});
