import { board as boardAt, type Board } from "@vercel/board";
import { http } from "@vercel/board/backend-http";
import { commandWord, vb } from "@vercel/board/cli";
import { z } from "zod";
import { AVATAR, BOARD, NAME, VB_ROUTES, headers } from "./identity";

// The vb tool: vb's board commands, run in the function against the board, without starting `vb` in
// the sandbox. It's who `vb` is there: the same token, profile, and session the sandbox's network
// policy adds. Files (--attach, download) are the sandbox's.

export const inputSchema = z.object({
  args: z
    .array(z.string())
    .describe(
      'vb\'s arguments, one per item, as you\'d type them after vb: ["read", "42"], ["reply", "42", "on it", "--attach", "~/shot.png"], ["label", "42", "kind=bug"], ["read", "dev", "--text", "attach"].',
    ),
});

/** The agent working on `thread`, on the board through `fetch`, with a fresh token for each request. */
export function agentBoard(
  thread: string,
  options: { token: () => Promise<string>; bypass?: string | undefined; fetch?: typeof fetch; signal?: AbortSignal },
): Board {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const routes = new RegExp(VB_ROUTES);
  const withAgent: typeof fetch = async (input, init) => {
    // Only the routes the sandbox's policy lets vb reach with the agent's token: never sources, inbox,
    // identity, sync, or watchers, which board content could otherwise steer the agent into reading.
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(BOARD).origin || !routes.test(url.pathname))
      throw new Error(`the vb tool can't reach ${url.pathname.replace(new URL(BOARD).pathname, "") || "/"}: it's not a route the agent uses`);
    const sent = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(headers(thread, await options.token(), options.bypass))) sent.set(name, value);
    // A call's signal reaches every request it makes, so a hung read or upload ends with it.
    const signals = [init?.signal, options.signal].filter((signal): signal is AbortSignal => !!signal);
    return send(input, { ...init, headers: sent, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
  };
  return boardAt({ backend: http(BOARD, { fetch: withAgent }) }).as({ name: NAME, avatar: AVATAR });
}

/** The sandbox's home, where clones and skills live. */
export const SANDBOX_HOME = "/home/vercel-sandbox";

/** A path as the model writes it: `~/…` and `$HOME/…` are in the sandbox's home, as its file tools read them. */
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
 * instance, so a call that hung would hold every session's: pass it to `agentBoard` and `runVb` both.
 */
export const callSignal = (turn?: AbortSignal, ms = CALL_MS) => AbortSignal.any([AbortSignal.timeout(ms), ...(turn ? [turn] : [])]);

/** Runs a vb command as the agent, and says what it printed, as bash would: stdout, then stderr, then a failure's exit code. */
export async function runVb(board: Board, args: string[], files: () => Promise<SandboxFiles>, signal?: AbortSignal): Promise<string> {
  // tail and wait don't run: every session on this instance would wait behind them, and a tool call
  // can't stream. `signal` ends the rest.
  const { code, stdout, stderr } = await vb(board, args, {
    ...(signal ? { signal } : {}),
    refuse: ["tail", "wait"],
    readFile: async (path) => (await files()).readBinaryFile({ path: sandboxPath(path) }),
    writeFile: async (path, content) => (await files()).writeBinaryFile({ path: sandboxPath(path), content }),
  });
  const word = commandWord(args);
  const elsewhere = word === "tail" || word === "wait" ? `run vb ${word} in bash instead` : "";
  return [stdout.trimEnd(), stderr.trimEnd(), elsewhere, code === 0 ? "" : `(exit ${code})`].filter(Boolean).join("\n") || "(no output)";
}
