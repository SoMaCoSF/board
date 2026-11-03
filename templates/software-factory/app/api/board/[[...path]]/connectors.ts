type Env = Record<string, string | undefined>;

export const CHANNEL = "dev";

/** Where people talk about the factory itself, and where the setup page's chat posts. */
export const FACTORY_CHANNEL = `${CHANNEL}/factory`;

/** Your repos (`owner/name`, as GitHub writes it) and the channel each one's PRs and issues come into. */
const REPOS: Record<string, string> = {
  // "acme/web": CHANNEL,
  // "acme/api": `${CHANNEL}/api`,
};

export function connectors(env: Env = process.env) {
  const own = env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
  return {
    github: env.GITHUB_CONNECTOR || "github/factory",
    /** Null where it isn't deployed from Git. */
    ownRepo: own,
    repos: { ...(own ? { [own]: FACTORY_CHANNEL } : {}), ...REPOS } as Record<string, string>,
    slack: env.SLACK_CONNECTOR || "slack/factory",
    slackChannel: env.SLACK_CHANNEL || "#factory",
  };
}

export const { github: GITHUB, ownRepo: OWN_REPO, repos: GITHUB_REPOS, slack: SLACK, slackChannel: SLACK_CHANNEL } = connectors();

/** The repos a thread's GitHub token covers: its own (`pr=` or `issue=` on the root), else every repo in the map. */
export function threadRepos(root: { labels: Record<string, string> }, repos: Record<string, string> = GITHUB_REPOS): string[] {
  const from = (root.labels.pr ?? root.labels.issue)?.replace(/#\d+$/, "");
  return from ? [from] : Object.keys(repos);
}

/** What Connect needs to mint a GitHub token for `repos` alone. A token covers one org: the first repo's. */
export function githubScope(repos: string[]) {
  const org = repos[0]?.split("/")[0];
  if (!org) return null;
  const repositories = repos.filter((repo) => repo.split("/")[0] === org).map((repo) => repo.split("/")[1]!);
  return [{ type: "github_app_installation" as const, org, repositories }];
}
