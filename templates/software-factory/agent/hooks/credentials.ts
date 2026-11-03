import { defineHook } from "eve/hooks";
import { boardOf } from "../lib/board";
import { give } from "../lib/credentials";

// Fresh tokens in the sandbox's network policy at every turn's start.
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const board = boardOf(ctx.session);
      if (board) await give(ctx, board, { force: true });
    },
  },
});
