import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";
import { boardOf } from "../lib/board";
import { give } from "../lib/credentials";
import { runsProjectCode } from "../lib/isolated";

// eve's bash, renewing the sandbox's credentials first when they're near their end. A review's
// bash doesn't run the PR's code: the isolated tool does, in a sandbox without them.
export default defineTool({
  ...bash,
  async *execute(input, ctx) {
    const board = boardOf(ctx.session);
    if (board?.task === "review" && runsProjectCode(input.command)) {
      const stderr = "Not run: in a review, a package manager or node would run the PR's code with your credentials. Use the isolated tool for it.";
      yield { status: "completed", exitCode: 1, stderr, stdout: "", truncated: false } as never;
      return;
    }
    if (board) await give(ctx, board);
    const output = await bash.execute(input, ctx);
    if (Symbol.asyncIterator in Object(output)) yield* output as AsyncIterable<never>;
    else yield output as never;
  },
});
