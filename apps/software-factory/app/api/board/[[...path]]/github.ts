import { getToken } from "@vercel/connect";

// The factory's GitHub: its repo, its bot, and its API calls as the factory GitHub App.
// Watchers that read or merge PRs (shipit, owner, autoland) share it.

export const REPO = "vercel-labs/vboard";

/**
 * The factory GitHub App's Connect connector (`github/<name>`), from FACTORY_GITHUB_CONNECTOR. Without one the
 * board syncs Slack alone and Pi works without GitHub: an app on vercel-labs waits on an org owner to install it.
 */
export const CONNECTOR = process.env.FACTORY_GITHUB_CONNECTOR || null;

const PR = new RegExp(`^${REPO.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}#([1-9]\\d*)$`);
/** The PR number on a PR thread's root, from its `pr=vercel-labs/vboard#N` label. Other repos' PRs give none. */
export const prNumber = (labels: Record<string, string>) => labels.pr?.match(PR)?.[1];

/** What a watcher takes to reach GitHub, so tests can stand in for the token and the network. */
export type GitHubOptions = { token?: () => Promise<string>; fetch?: typeof fetch };

/**
 * GitHub's API as the factory GitHub App. `path` is under the repo (`/pulls/12`) or a full
 * URL (`https://api.github.com/graphql`); a body makes it a PUT unless `method` says otherwise.
 * A rejection or GraphQL error throws with GitHub's message.
 */
export async function github(options: GitHubOptions = {}) {
  const request = options.fetch ?? globalThis.fetch;
  if (!options.token && !CONNECTOR) throw new Error("GitHub isn't connected: FACTORY_GITHUB_CONNECTOR is unset.");
  const token = await (options.token?.() ?? getToken(CONNECTOR!, { subject: { type: "app" } }));
  return async (path: string, body?: object, method = body ? "PUT" : "GET") => {
    const response = await request(path.startsWith("https://") ? path : `https://api.github.com/repos/${REPO}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? `GitHub returned ${response.status}`);
    if (data.errors?.length) throw new Error(data.errors[0].message ?? "GitHub returned GraphQL errors.");
    return data;
  };
}

/**
 * The factory GitHub App's bot account, which opens Pi's PRs and authors its commits: GraphQL's viewer for the app's
 * token, so nothing pins the app's name or ID. GraphQL leaves off the `[bot]` that REST's logins carry.
 */
export async function bot(api: Awaited<ReturnType<typeof github>>) {
  const { data } = await api("https://api.github.com/graphql", { query: "query { viewer { databaseId login } }" }, "POST");
  const login: string = data.viewer.login.endsWith("[bot]") ? data.viewer.login : `${data.viewer.login}[bot]`;
  return { login, email: `${data.viewer.databaseId}+${login}@users.noreply.github.com` };
}
