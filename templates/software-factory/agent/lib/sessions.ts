import type { WatcherContext } from "@vercel/board";
import { session } from "./identity";

// The board reaches the agent over eve's HTTP API on this deployment: one eve session per thread,
// kept in the project's Redis.

/** The GitHub connector the agent acts through, and the repos the board brings in (`owner/name`). */
export type GitHubAccess = { github: string; repos: string[] };

export type AgentMessage = { thread: string; key: string; text: string; github: GitHubAccess };

export type Sessions = {
  get(key: string): Promise<string | null>;
  claim(key: string, value: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type EveSessions = {
  create(): Promise<string>;
  send(session: string, text: string, clientContext: object): Promise<void>;
  reset(session: string): Promise<void>;
};

/** Ended (idle timeout, reset) or built by an older eve. */
const gone = (error: unknown) =>
  error instanceof Error &&
  (error.name === "SessionNotActiveError" ||
    error.name === "ClientSessionStrandedError" ||
    (error as { code?: string }).code === "session_stranded");

/** Delivers a message to the thread's session, once per `key`. Two racing first messages each make a session; the loser's is reset. */
export async function deliver({ thread, key, text, github }: AgentMessage, deps: { sessions?: Sessions; eve?: EveSessions } = {}) {
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
    try {
      await eve.send(session, text, { board: { thread, ...github } });
    } catch (error) {
      if (!gone(error)) throw error;
      const fresh = await eve.create();
      await sessions.set(`session:${name}`, fresh);
      await eve.send(fresh, text, { board: { thread, ...github } });
    }
  } catch (error) {
    await sessions.delete(`told:${name}:${key}`).catch(() => {});
    throw error;
  }
}

/**
 * Delivers a message to the agent, trying 3 times, and says so in the thread if it never gets there.
 * Throwing instead would lose it quietly: board retries a watcher 5 times in about 15 seconds, then
 * drops the event.
 */
export async function sendToAgent(board: Pick<WatcherContext["board"], "reply">, message: AgentMessage, retryMs = 5_000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deliver(message);
    } catch (error) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, retryMs * attempt));
        continue;
      }
      console.error(`[factory] the agent couldn't start on board thread #${message.thread}:`, error);
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
      await board.reply(message.thread, `The agent couldn't start: \`${reason}\`. Reply here to try again.`);
      return;
    }
  }
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
