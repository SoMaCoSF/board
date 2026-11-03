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
    /** Vercel, for the agent's `vercel` CLI: a Connect connector one person authorizes, as whom the agent runs it. */
    vercel: env.VERCEL_CONNECTOR || "vercel/factory",
  };
}

/** The one account Connect's Vercel connector holds for the agent: whoever connects it on the setup page. */
export const VERCEL_SUBJECT = { type: "user", id: "factory" } as const;

/** A team token the agent's `vercel` CLI uses instead of the connector, kept out of the sandbox like every credential. */
export const VERCEL_TOKEN_ENV = "FACTORY_VERCEL_TOKEN";

export const { github: GITHUB, ownRepo: OWN_REPO, repos: GITHUB_REPOS, slack: SLACK, slackChannel: SLACK_CHANNEL } = connectors();
