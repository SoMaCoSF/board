type Env = Record<string, string | undefined>;

/** This factory's own repo, on a deployment from Git: null anywhere else. */
export function ownRepo(env: Env = process.env): string | null {
  return env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
}

/** The repos a thread's GitHub token covers: its own (`pr=` or `issue=` on the root), else all of `repos`. */
export function threadRepos(root: { labels: Record<string, string> }, repos: string[]): string[] {
  const from = (root.labels.pr ?? root.labels.issue)?.replace(/#\d+$/, "");
  return from ? [from] : repos;
}

/** What Connect needs to mint a GitHub token for `repos` alone. A token covers one org: the first repo's. */
export function githubScope(repos: string[]) {
  const org = repos[0]?.split("/")[0];
  if (!org) return null;
  const repositories = repos.filter((repo) => repo.split("/")[0] === org).map((repo) => repo.split("/")[1]!);
  return [{ type: "github_app_installation" as const, org, repositories }];
}
