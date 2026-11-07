import { Sandbox } from "@vercel/sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ISOLATED_DEFAULT, ISOLATED_POLICY, isolatedScript, packCommand } from "../lib/isolated";

const TAIL = 20_000;
const TIMEOUT_MS = 25 * 60_000;

// Runs a command against a copy of a checkout in a fresh sandbox with no credentials, then deletes it.
export default defineTool({
  description: `Runs a command against a copy of a checkout in a fresh, throwaway sandbox that has no credentials: no GitHub token, no board token, no AI gateway. Its default is ${ISOLATED_DEFAULT}. Use it for any code a pull request controls (pnpm install and its lifecycle scripts, pnpm check, pnpm test, a test you broke on purpose, the CLI by hand), never bash: your own sandbox carries your credentials. It copies the checkout's tracked files as they are now, uncommitted edits included, and returns the exit code and the end of the output. Each call starts from scratch, so chain what you need into one command.`,
  inputSchema: z.object({
    dir: z.string().min(1).describe("The checkout in your sandbox, like board (relative to the workspace) or an absolute path."),
    command: z.string().min(1).max(2_000).optional().describe(`A bash command, run at the checkout's root. Defaults to ${ISOLATED_DEFAULT}.`),
  }),
  async execute(input, ctx) {
    const mine = await ctx.getSandbox();
    const archive = `/tmp/isolated-${Date.now()}.tgz`;
    const packed = await mine.run({ command: packCommand(input.dir, archive), signal: ctx.abortSignal });
    if (packed.exitCode !== 0) return { exitCode: packed.exitCode, output: `couldn't copy ${input.dir}: ${packed.stderr.slice(-1_000)}` };
    const bytes = await mine.readBinaryFile({ path: archive, signal: ctx.abortSignal });
    await mine.run({ command: `rm -f ${archive}` });
    if (!bytes) return { exitCode: 1, output: `couldn't read the copy of ${input.dir}` };

    const isolated = await Sandbox.create({ runtime: "node24", timeout: TIMEOUT_MS, resources: { vcpus: 4 }, networkPolicy: ISOLATED_POLICY });
    try {
      await isolated.writeFiles([{ path: "/tmp/checkout.tgz", content: bytes }], { signal: ctx.abortSignal });
      const done = await isolated.runCommand({
        cmd: "bash",
        args: ["-lc", isolatedScript("/tmp/checkout.tgz", input.command ?? ISOLATED_DEFAULT)],
        signal: ctx.abortSignal,
      });
      return { exitCode: done.exitCode, output: (await done.output("both")).slice(-TAIL) };
    } finally {
      await isolated.stop().catch(() => {});
    }
  },
});
