import { board } from "vboard";

// A board that keeps no log: the software factory's board is its remote. The factory
// runs `ping`'s tail and sends each match here, where it runs as this project's code.
// `pings` isn't synced anywhere and no factory watcher reads it, so this touches no
// Slack, GitHub, or Pi. Try it with `vb post pings "hello"`.
export const { GET, POST } = board({
  remote: "https://vboard-factory.playground-vercel.tools/api/board",
  watch: {
    ping: {
      tail: "pings",
      run: async ({ event, board }) => {
        if (event.type !== "message.posted" || event.message?.re !== null) return;
        const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
        await board.reply(event.message.id, `pong from ${commit}`);
      },
    },
  },
});
