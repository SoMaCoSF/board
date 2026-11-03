// The Vercel Connect connectors the board syncs through, by UID, and where it syncs them. The
// launcher (lib/setup.ts) checks the same ones.

type Env = Record<string, string | undefined>;

export function connectors(env: Env = process.env) {
  return {
    /** The GitHub App the board reads PRs and issues through, and the agent pushes and opens PRs as. */
    github: env.GITHUB_CONNECTOR || "github/factory",
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

export const { github: GITHUB, slack: SLACK, slackChannel: SLACK_CHANNEL } = connectors();

/** The board channel people and the agent work in. The agent hears it and every channel under it. */
export const CHANNEL = "dev";

/** Where people talk about the factory itself: setting it up, how it works, changes to it. The launcher's chat is here. */
export const FACTORY_CHANNEL = `${CHANNEL}/factory`;
