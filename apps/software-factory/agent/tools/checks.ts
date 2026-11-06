import { defineTool } from "eve/tools";
import { z } from "zod";
import { boardOf } from "../lib/board";
import { withoutCredentials } from "../lib/credentials";

const TAIL = 20_000;

// pnpm install and a pnpm script in a checkout, with the sandbox's credentials off: a PR's
// package.json and lifecycle scripts are its author's code, not Eve's.
export default defineTool({
  description: `Runs pnpm install, then pnpm run <script> (check by default), in a checkout in the sandbox, with GitHub, the board and the AI gateway unreachable as you: a pull request's scripts run as its author, not as you. Use this, not bash, to install and check a pull request someone else wrote. It returns the exit code and the end of the output.`,
  inputSchema: z.object({
    dir: z.string().min(1).describe("The checkout, like board (relative to the workspace) or an absolute path."),
    script: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,64}$/)
      .optional()
      .describe("The package.json script to run after pnpm install. Defaults to check."),
  }),
  async execute(input, ctx) {
    const board = boardOf(ctx.session);
    if (!board) throw new Error("the checks tool works only in a board thread's session");
    const sandbox = await ctx.getSandbox();
    const done = await withoutCredentials(ctx, board, () =>
      sandbox.run({
        command: `pnpm install 2>&1 && pnpm run ${input.script ?? "check"} 2>&1`,
        workingDirectory: input.dir,
        signal: ctx.abortSignal,
      }),
    );
    return { exitCode: done.exitCode, output: `${done.stdout}${done.stderr}`.slice(-TAIL) };
  },
});
