import { defineTool } from "eve/tools";
import { asEve, factory } from "../../app/api/board/[[...path]]/factory.ts";
import { boardOf } from "../lib/board";
import { callSignal, eveBoard, inputSchema, runVb } from "../lib/vb-tool.ts";

// Eve's vb tool: vb's board commands, from the function on the factory's own board, not through `vb`
// in the sandbox. The CLI in bash stays for the commands about its machine (verify-board's local board).

export default defineTool({
  description: `vb, the board's CLI, without the sandbox: runs one vb command (read, reply, react, label, typing, download, schedule, …) against the board and returns what vb prints. args are vb's arguments; ["help"] lists them all. --attach reads and download writes the sandbox's files.`,
  inputSchema,
  async execute(input, ctx) {
    const board = boardOf(ctx.session);
    if (!board) throw new Error("the vb tool works only in a board thread's session");
    // Ends with the turn, or in a few minutes: every request it makes, too.
    const signal = callSignal(ctx.abortSignal);
    return asEve({ thread: board.thread, signal }, () => runVb(eveBoard(factory, board.thread), input.args, () => ctx.getSandbox(), signal));
  },
});
