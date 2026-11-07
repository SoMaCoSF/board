import { AsyncLocalStorage } from "node:async_hooks";
import { eveSession } from "./harness.ts";

/**
 * What an Eve's vb command may not reach on Vercel's board: sync's records and inbox, grants,
 * tokens, and making boards. Board content could otherwise steer Eve into writing as a platform,
 * or reading what the platforms sent that never reached a channel.
 */
const OFF_LIMITS = /^\/v1\/messageboard\/(boards\/(ensure|default)$|boards\/[^/]+\/(sync\/(imports|receipts|inbox)|grants|tokens)(\/|$))/;

/**
 * The board's own watcher registration and pulls. They aren't Eve's: when the board's first use is
 * an Eve's command, or a registration is retried during one, they go as the project, never refused.
 * No vb command the tool runs reaches them.
 */
const WATCHERS = /^\/v1\/messageboard\/boards\/[^/]+\/watchers(\/|$)/;

/** Whether an Eve's request may go to `url`: Vercel's messageboard API, outside OFF_LIMITS. */
export const eveReaches = (url: URL) => url.pathname.startsWith("/v1/messageboard/") && !OFF_LIMITS.test(url.pathname);

/** One of an Eve's vb commands: the thread it's for, and what ends it. */
export type EveCall = { thread: string; signal?: AbortSignal };

/**
 * Where an Eve's vb commands run: `asEve` runs one, which `call()` names inside it. `warm` is the
 * board's first use, run once outside any command, so the watchers' registration and pull loop
 * start in no Eve's context, and their deliveries never carry an Eve's session.
 */
export function eveScope(warm: () => Promise<unknown>) {
  const store = new AsyncLocalStorage<EveCall>();
  const outside = AsyncLocalStorage.snapshot();
  let warmed: Promise<unknown> | null = null;
  return {
    call: () => store.getStore(),
    async asEve<T>(call: EveCall, fn: () => Promise<T>): Promise<T> {
      warmed ??= outside(warm).catch((error: unknown) => {
        warmed = null;
        throw error;
      });
      await warmed.catch(() => {});
      return store.run(call, fn);
    },
  };
}

/**
 * How the factory's board reaches Vercel's API: as this deployment's project, with its token. While
 * `call()` names one of an Eve's commands, it's that thread's Eve, with its session, only where
 * `eveReaches`, and ended by the command's signal. Its profile and avatar come from the handle's `as()`.
 */
export function eveFetch(options: {
  token: () => Promise<string>;
  call: () => EveCall | undefined;
  fetch?: typeof fetch;
}): typeof fetch {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async (input, init) => {
    const call = options.call();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let signal = init?.signal ?? undefined;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (call !== undefined && !WATCHERS.test(url.pathname)) {
      if (!eveReaches(url)) throw new Error(`the vb tool can't reach ${url.pathname.replace(/^\/v1\/messageboard/, "")}: it's not a route Eve uses`);
      headers.set("x-board-session", eveSession(call.thread));
      // A command's signal ends every request it makes, so a hung one doesn't hold the calls behind it.
      if (call.signal) signal = signal ? AbortSignal.any([signal, call.signal]) : call.signal;
    }
    headers.set("authorization", `Bearer ${await options.token()}`);
    return send(input, { ...init, headers, ...(signal ? { signal } : {}) });
  };
}
