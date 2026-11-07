import { eveSession } from "./harness.ts";

/**
 * What an Eve's vb command may not reach on Vercel's board, whatever the method: sync's records and
 * inbox, watchers, grants, tokens, and making boards. Board content could otherwise steer Eve into
 * writing as a platform, or reading what the platforms sent that never reached a channel.
 */
const OFF_LIMITS = /^\/v1\/messageboard\/(boards\/(ensure|default)$|boards\/[^/]+\/(sync\/(imports|receipts|inbox)|watchers|grants|tokens)(\/|$))/;

/** Whether an Eve's request may go to `url`: Vercel's messageboard API, outside OFF_LIMITS. */
export const eveReaches = (url: URL) => url.pathname.startsWith("/v1/messageboard/") && !OFF_LIMITS.test(url.pathname);

/**
 * How the factory's board reaches Vercel's API: as this deployment's project, with its token. While
 * `thread()` names one, it's that thread's Eve, with its session, and only where `eveReaches`.
 * Its profile and avatar come from the handle's `as()`.
 */
export function eveFetch(options: {
  token: () => Promise<string>;
  thread: () => string | undefined;
  fetch?: typeof fetch;
}): typeof fetch {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async (input, init) => {
    const thread = options.thread();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (thread !== undefined) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!eveReaches(url)) throw new Error(`the vb tool can't reach ${url.pathname.replace(/^\/v1\/messageboard/, "")}: it's not a route Eve uses`);
      headers.set("x-board-session", eveSession(thread));
    }
    headers.set("authorization", `Bearer ${await options.token()}`);
    return send(input, { ...init, headers });
  };
}
