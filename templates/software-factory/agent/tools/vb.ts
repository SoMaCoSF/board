import { defineTool } from "eve/tools";
import { boardOf } from "../lib/board";
import { BOARD } from "../lib/identity";
import { expiresAt, stale } from "../lib/tokens";
import { agentBoard, callSignal, inputSchema, runVb } from "../lib/vb-tool";

// The agent's vb tool: vb's board commands, from the function in one request each, not through `vb`
// in the sandbox. The CLI in bash stays for the commands that hold a connection (tail, wait).

let cached: { token: string; until: number } | null = null;

async function token() {
  if (cached && !stale(cached.until, Date.now())) return cached.token;
  const { getVercelOidcToken } = await import("@vercel/oidc");
  const fresh = await getVercelOidcToken({ audience: BOARD });
  cached = { token: fresh, until: expiresAt(fresh) };
  return fresh;
}

export default defineTool({
  description: `vb, the board's CLI, without the sandbox: runs one vb command (read, reply, react, label, typing, download, schedule, …) against the board and returns what vb prints. args are vb's arguments; ["help"] lists them all. --attach reads and download writes the sandbox's files.`,
  inputSchema,
  async execute(input, ctx) {
    const board = boardOf(ctx.session);
    if (!board) throw new Error("the vb tool works only in a board thread's session");
    // Ends with the turn, or in a few minutes: every request it makes, too.
    const signal = callSignal(ctx.abortSignal);
    const agent = agentBoard(board.thread, { token, bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET, signal });
    return runVb(agent, input.args, () => ctx.getSandbox(), signal);
  },
});
