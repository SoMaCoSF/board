// The Vercel Connect connectors the board syncs through, by UID, and where it syncs them. The
// launcher (lib/setup.ts) checks the same ones.

type Env = Record<string, string | undefined>;

/** The board channel people and the agent work in. The agent hears it and every channel under it. */
export const CHANNEL = "dev";

/** Where people talk about the factory itself: setting it up, how it works, changes to it. The launcher's chat is here. */
export const FACTORY_CHANNEL = `${CHANNEL}/factory`;

/**
 * Your repos, by `owner/name` as GitHub writes it, and the board channel each one's PRs and issues
 * come into: dev, or a channel under it, so the agent hears them. This factory's own repo comes into
 * dev/factory without being listed. A repo the GitHub App is on that isn't here stays off the board.
 */
const REPOS: Record<string, string> = {
  // "acme/web": CHANNEL,
  // "acme/api": `${CHANNEL}/api`,
};

export function connectors(env: Env = process.env) {
  const own = env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
  return {
    /** The GitHub App the board reads PRs and issues through, and the agent pushes and opens PRs as. */
    github: env.GITHUB_CONNECTOR || "github/factory",
    /** This factory's own repo, which it changes when it's asked to improve itself: null where it isn't deployed from Git. */
    ownRepo: own,
    /** Where each repo's PRs and issues come into: this factory's own into dev/factory, unless REPOS says otherwise, and yours. */
    repos: { ...(own ? { [own]: FACTORY_CHANNEL } : {}), ...REPOS } as Record<string, string>,
    /** Slack: the board mirrors `slackChannel` (a name or an ID) into its channel, once this connector exists. */
    slack: env.SLACK_CONNECTOR || "slack/factory",
    slackChannel: env.SLACK_CHANNEL || "#factory",
  };
}

export const { github: GITHUB, ownRepo: OWN_REPO, repos: GITHUB_REPOS, slack: SLACK, slackChannel: SLACK_CHANNEL } = connectors();

/**
 * The repos a thread's GitHub token covers: the one its root came from (`pr=` or `issue=`, which
 * GitHub sync labels it with), else every repo the board brings in, this factory's own first.
 */
export function threadRepos(root: { labels: Record<string, string> }, repos: Record<string, string> = GITHUB_REPOS): string[] {
  const from = (root.labels.pr ?? root.labels.issue)?.replace(/#\d+$/, "");
  return from ? [from] : Object.keys(repos);
}

/**
 * What Vercel Connect needs to mint a GitHub token for `repos` (`owner/name`) alone. One
 * installation token covers one org: the first repo's, with those of its repos. Null for no repos.
 */
export function githubScope(repos: string[]) {
  const org = repos[0]?.split("/")[0];
  if (!org) return null;
  const repositories = repos.filter((repo) => repo.split("/")[0] === org).map((repo) => repo.split("/")[1]!);
  return [{ type: "github_app_installation" as const, org, repositories }];
}
