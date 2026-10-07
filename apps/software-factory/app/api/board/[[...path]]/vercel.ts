// The factory's Vercel App, which gives Pi read-only access to the factory's own logs.
//
// The Vercel API won't take a deployment's OIDC token as a bearer, and these apps don't
// do client_credentials, so someone authorizes the app once (/api/vercel-auth), granting
// it read-only permissions. The board keeps the refresh token and trades it for access
// tokens, authenticating as the app with its OIDC token instead of a client secret: the
// stored token is useless anywhere but this project. Refresh tokens are single use and
// rotate on every exchange, so the latest one is kept, and a lock lets one turn refresh
// while the others wait for its access token.

export const VERCEL_APP = "cl_9xSOKjNw4cBZlR0fIUkhl2uIwsCJrFLp";
const TOKEN_URL = "https://api.vercel.com/login/oauth/token";
export const AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
/** Refresh tokens last 30 days; access tokens an hour, of which we use 55 minutes at most. */
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const EARLY_S = 5 * 60;

/** Where the tokens live: production's Redis keys, or a preview's own. */
export type Store = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { ttlSeconds: number; onlyIfNew?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
};

const KEYS = { refresh: "vercel-app:refresh", access: "vercel-app:access", lock: "vercel-app:lock" };

/** Upstash's REST API, which the board's Redis already speaks. Locally, memory. */
export function defaultStore(): Store {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const env = process.env.VERCEL_ENV;
  if (!url || !token || !env) return memoryStore();
  const prefix = env === "production" ? "vboard-factory:" : `vboard-factory:${env}:`;
  const command = async (args: (string | number)[]) => {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
    if (!res.ok) throw new Error(`redis ${args[0]}: ${res.status}`);
    return ((await res.json()) as { result: unknown }).result;
  };
  return {
    get: async (key) => ((await command(["GET", prefix + key])) as string | null) ?? null,
    set: async (key, value, { ttlSeconds, onlyIfNew }) =>
      (await command(["SET", prefix + key, value, "EX", ttlSeconds, ...(onlyIfNew ? ["NX"] : [])])) === "OK",
    del: async (key) => void (await command(["DEL", prefix + key])),
  };
}

export function memoryStore(): Store {
  const data = new Map<string, { value: string; until: number }>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry && entry.until > Date.now()) return entry.value;
    data.delete(key);
    return null;
  };
  return {
    get: async (key) => live(key),
    set: async (key, value, { ttlSeconds, onlyIfNew }) => {
      if (onlyIfNew && live(key) !== null) return false;
      data.set(key, { value, until: Date.now() + ttlSeconds * 1000 });
      return true;
    },
    del: async (key) => void data.delete(key),
  };
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };

/** One call to the token endpoint, authenticating as the app with the deployment's OIDC token. */
async function exchange(oidc: string, grant: Record<string, string>, fetcher: typeof fetch): Promise<Tokens> {
  const res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...grant,
      client_id: VERCEL_APP,
      client_assertion_type: "urn:vercel:params:oauth:client-assertion-type:oidc-bearer",
      client_assertion: oidc,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<Tokens> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`vercel app token: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
  }
  return body as Tokens;
}

async function keep(store: Store, tokens: Tokens) {
  if (tokens.refresh_token) await store.set(KEYS.refresh, tokens.refresh_token, { ttlSeconds: REFRESH_TTL_S });
  const ttl = Math.max(60, (tokens.expires_in ?? 3600) - EARLY_S);
  await store.set(KEYS.access, tokens.access_token, { ttlSeconds: ttl });
}

/** The callback's half: a fresh authorization's code becomes the first token pair. */
export async function authorize(options: {
  oidc: string;
  code: string;
  verifier: string;
  redirectUri: string;
  store?: Store;
  fetch?: typeof fetch;
}) {
  const store = options.store ?? defaultStore();
  const tokens = await exchange(
    options.oidc,
    { grant_type: "authorization_code", code: options.code, code_verifier: options.verifier, redirect_uri: options.redirectUri },
    options.fetch ?? fetch,
  );
  if (!tokens.refresh_token) throw new Error("vercel app token: no refresh token (is offline_access enabled on the app?)");
  await keep(store, tokens);
}

/**
 * An access token for Pi's turn, or undefined when nobody has authorized the app yet.
 * Refreshes when the cached one is gone; a concurrent turn waits for that refresh rather than
 * spending the same single-use refresh token twice.
 */
export async function vercelToken(options: {
  oidc: string;
  store?: Store;
  fetch?: typeof fetch;
  waitMs?: number;
}): Promise<string | undefined> {
  const store = options.store ?? defaultStore();
  const cached = await store.get(KEYS.access);
  if (cached) return cached;
  if (!(await store.set(KEYS.lock, "1", { ttlSeconds: 15, onlyIfNew: true }))) {
    const until = Date.now() + (options.waitMs ?? 10_000);
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const access = await store.get(KEYS.access);
      if (access) return access;
    }
    return undefined;
  }
  try {
    const refresh = await store.get(KEYS.refresh);
    if (!refresh) return undefined;
    const tokens = await exchange(options.oidc, { grant_type: "refresh_token", refresh_token: refresh }, options.fetch ?? fetch);
    await keep(store, tokens);
    return tokens.access_token;
  } finally {
    await store.del(KEYS.lock);
  }
}
