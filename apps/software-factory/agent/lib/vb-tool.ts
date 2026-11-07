import type { Board } from "@vercel/board";
import { commandWord, vb } from "@vercel/board/cli";
import { z } from "zod";
import { DEV, eveAvatar, eveName, SANDBOX_USER } from "../../app/api/board/[[...path]]/harness.ts";

// The vb tool: vb's board commands, run in the function on the factory's own board handle, without
// starting `vb` in the sandbox, so typing and reads reach Slack through its sync. Files (--attach,
// download) are the sandbox's.

export const inputSchema = z.object({
  args: z
    .array(z.string())
    .describe(
      `vb's arguments, one per item, as you'd type them after vb: ["read", "42"], ["reply", "42", "on it", "--attach", "~/shot.png"], ["label", "42", "kind=bug"], ["read", "${DEV}", "--text", "attach"].`,
    ),
});

export type VbInput = z.infer<typeof inputSchema>;

/** A thread's Eve on `board`: its profile and avatar. Run its commands in `asEve`, which adds its session. */
export const eveBoard = (board: Board, thread: string): Board => board.as({ name: eveName(thread), avatar: eveAvatar(thread) });

/**
 * Commands the vb tool doesn't run: tail and wait would hold every other Eve's calls on the
 * instance; sources, inbox, and identity read what the platforms sent outside the board's
 * channels, which board content could otherwise steer Eve into reading; and tokens, grants, hooks,
 * and conformance act as the factory's project on the board itself.
 */
const REFUSED = ["tail", "wait", "sources", "inbox", "identity", "tokens", "grants", "hooks", "hook", "conformance"];

/** The sandbox's home, where clones and skills live. */
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;

/** A path as the model writes it: `~/…` and `$HOME/…` are in the sandbox's home, as Eve's file tools read them. */
export const sandboxPath = (path: string, home = SANDBOX_HOME) => path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

/** The sandbox's files, for --attach and download. */
export type SandboxFiles = {
  readBinaryFile(options: { path: string }): PromiseLike<Uint8Array | null>;
  writeBinaryFile(options: { path: string; content: Uint8Array }): PromiseLike<void>;
};

/** The longest a vb tool call runs. */
export const CALL_MS = 3 * 60_000;

/**
 * What ends a vb tool call: the turn's end, or `ms`. `vb()` runs one call at a time across the
 * instance, so a call that hung would hold every Eve's.
 */
export const callSignal = (turn?: AbortSignal, ms = CALL_MS) => AbortSignal.any([AbortSignal.timeout(ms), ...(turn ? [turn] : [])]);

/** Runs a vb command as Eve, and says what it printed, as bash would: stdout, then stderr, then a failure's exit code. */
export async function runVb(board: Board, args: string[], files: () => Promise<SandboxFiles>, signal?: AbortSignal): Promise<string> {
  // REFUSED don't run. `signal` (callSignal's) ends the rest.
  const { code, stdout, stderr } = await vb(board, args, {
    ...(signal ? { signal } : {}),
    refuse: REFUSED,
    readFile: async (path) => (await files()).readBinaryFile({ path: sandboxPath(path) }),
    writeFile: async (path, content) => (await files()).writeBinaryFile({ path: sandboxPath(path), content }),
  });
  const word = commandWord(args);
  const elsewhere = word === "tail" || word === "wait" ? `run vb ${word} in bash instead` : "";
  return [stdout.trimEnd(), stderr.trimEnd(), elsewhere, code === 0 ? "" : `(exit ${code})`].filter(Boolean).join("\n") || "(no output)";
}
