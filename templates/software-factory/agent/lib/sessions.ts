import type { WatcherContext } from "@vercel/board";
import { session } from "./identity";

// How the board's watchers reach the agent: over eve's HTTP API on this deployment, one eve session
// per thread, kept in the project's Redis. Each message is sent once per key.

export type AgentMessage = { thread: string; key: string; message: string };

export const boardContext = (thread: string) => ({ board: { thread } });

export type Sessions = {
  get(key: string): Promise<string | null>;
  claim(key: string, value: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type EveSessions = {
  create(): Promise<string>;
  send(session: string, message: string, clientContext: object): Promise<void>;
  reset(session: string): Promise<void>;
};

/** Ended (idle timeout, reset) or built by an older eve. */
const gone = (error: unknown) =>
  error instanceof Error &&
  (error.name === "SessionNotActiveError" ||
    error.name === "ClientSessionStrandedError" ||
    (error as { code?: string }).code === "session_stranded");

/** Sends a message once per `key`. Two racing first messages each make a session; the loser's is reset. */
export async function send(
  { thread, key, message }: AgentMessage,
  deps: { sessions?: Sessions; eve?: EveSessions } = {},
) {
  const sessions = deps.sessions ?? (await kv());
  const eve = deps.eve ?? (await client());
  const name = session(thread);
  if (!(await sessions.claim(`told:${name}:${key}`, "1"))) return;
  try {
    let session = await sessions.get(`session:${name}`);
    if (!session) {
      const made = await eve.create();
      if (await sessions.claim(`session:${name}`, made)) session = made;
      else {
        await eve.reset(made).catch(() => {});
        session = (await sessions.get(`session:${name}`))!;
      }
    }
    const context = boardContext(thread);
    try {
      await eve.send(session, message, context);
    } catch (error) {
      if (!gone(error)) throw error;
      const fresh = await eve.create();
      await sessions.set(`session:${name}`, fresh);
      await eve.send(fresh, message, context);
    }
  } catch (error) {
    await sessions.delete(`told:${name}:${key}`).catch(() => {});
    throw error;
  }
}

/** How many times a message is tried before the thread hears the agent couldn't start, and the wait after a first failure. */
const TRIES = 3;
const RETRY_MS = 5_000;

/**
 * Runs `start` until it works, up to TRIES times, and if it never does, says so in the thread instead
 * of throwing: a watcher that throws gets 5 tries in about 15 seconds, then board drops the event
 * without a word in the thread. Saying so tells the thread, and the next reply tries again.
 */
export async function startOrSay(
  board: Pick<WatcherContext["board"], "reply">,
  thread: string,
  start: () => Promise<void>,
  retryMs = RETRY_MS,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (attempt < TRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
        continue;
      }
      console.error(`[factory] the agent couldn't start on board thread #${thread}:`, error);
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
      await board.reply(thread, `The agent couldn't start: \`${reason}\`. Reply here to try again.`);
      return;
    }
  }
}

/** Tells the agent about a thread, and says so in the thread when it can't. */
export async function tell(board: Pick<WatcherContext["board"], "reply">, input: AgentMessage) {
  await startOrSay(board, input.thread, () => send(input));
}

/**
 * Where a thread came from, for the agent's PR: a GitHub issue's or PR's link, or the platform.
 * `origin.thread` is the sync target: `slack:C0123:1727000000.123456`, `github:owner/repo:issue:12`.
 */
export function sourceOf(origin: { thread: string } | null | undefined) {
  const thread = origin?.thread ?? "";
  const gh = /^github:([^/:]+\/[^/:]+):(issue:)?(\d+)$/.exec(thread);
  if (gh) return { platform: "GitHub", url: `https://github.com/${gh[1]}/${gh[2] ? "issues" : "pull"}/${gh[3]}` };
  if (thread.startsWith("slack:")) return { platform: "Slack", url: null };
  return null;
}

/** The message that tells the agent about a new thread, with where it came from when it's synced. */
export function taskMessage(thread: { id: string; origin: { thread: string } | null; author?: { name: string } | null }) {
  const source = sourceOf(thread.origin);
  const by = thread.author?.name ? ` by ${thread.author.name}` : "";
  const where = source ? `, posted${by} on ${source.platform}${source.url ? `: ${source.url}` : ""}` : "";
  return `There's a new thread on the board, #${thread.id}${where}.`;
}

async function client(): Promise<EveSessions> {
  const [{ Client }, { getVercelOidcToken }] = await Promise.all([import("eve/client"), import("@vercel/oidc")]);
  const host = process.env.VERCEL_URL;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const eve = new Client({
    baseUrl: host ? `https://${host}` : `http://localhost:${process.env.PORT ?? 3000}`,
    ...(host ? { auth: { vercelOidc: { token: () => getVercelOidcToken() } } } : {}),
    ...(bypass ? { headers: { "x-vercel-protection-bypass": bypass } } : {}),
  });
  return {
    create: async () => (await eve.sessions.create()).session.id,
    send: async (session, message, clientContext) => {
      await eve.sessions.attach(session).send(message, { clientContext: clientContext as never });
    },
    reset: async (session) => {
      await eve.sessions.attach(session).reset();
    },
  };
}

async function kv(): Promise<Sessions> {
  const env = process.env.VERCEL_ENV;
  if (!env) return memory();
  const prefix = env === "production" ? "factory-agent" : `factory-agent:${env}`;
  const call = async (...command: string[]) => {
    const response = await fetch(process.env.KV_REST_API_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok || data.error) throw new Error(`Upstash: ${data.error ?? response.status}`);
    return data.result;
  };
  return {
    get: async (key) => ((await call("GET", `${prefix}:${key}`)) as string | null) ?? null,
    claim: async (key, value) => (await call("SET", `${prefix}:${key}`, value, "NX")) === "OK",
    set: async (key, value) => void (await call("SET", `${prefix}:${key}`, value)),
    delete: async (key) => void (await call("DEL", `${prefix}:${key}`)),
  };
}

const local = new Map<string, string>();

/** Locally, and in tests. */
export function memory(map = local): Sessions {
  return {
    get: async (key) => map.get(key) ?? null,
    claim: async (key, value) => (map.has(key) ? false : (map.set(key, value), true)),
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
  };
}
