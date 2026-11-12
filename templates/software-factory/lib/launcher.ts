import { boardName, connectors, factory, repoChannels, slackChannels } from "@/app/api/board/[[...path]]/factory";
import type { FirstTask } from "./first-task.ts";
import { ownRepo } from "./github.ts";
import { joinPrompt } from "./markdown.ts";
import { overview, type Overview } from "./overview.ts";
import { channel, projectOf } from "./project.ts";
import { boardDeps, inspectCommand, isLocal, liveDeps, mirrorOf, progress, READ, setup, type Setup } from "./setup.ts";

// The launcher, checked now, for whichever of its faces was asked: the page, its markdown, or the
// steps the agent's setup_steps tool reads.

/** What the launcher shows once the factory runs. */
export type Running = {
  overview: Overview;
  /** The repos it works on, each with its channel. */
  repos: { repo: string; channel: string }[];
  /** How to onboard another: where to ask, on the board and in Slack, and how many repos have the GitHub app and no channel (null when that couldn't be told). */
  ask: { channel: string; slack: string | null; waiting: number | null };
  /** What to paste to a coding agent on your machine to have it join. */
  join: string;
  /** Where its first task stands, while the README is still the template's. */
  first: FirstTask;
};

export type Launcher = {
  result: Setup;
  /** The command that opens this factory's board in a browser. */
  inspect: string;
  /** Where this was asked, as a URL. */
  origin: string;
  /** A dev server, not a deployment. */
  local: boolean;
  running: Running | null;
};

/** Checks this deployment as `host` sees it: a preview can be open while production is closed. */
export async function check(host: string | null): Promise<Launcher> {
  const home = channel();
  const deps = await liveDeps(boardDeps(factory), { connectors, repoChannels, slackChannels, board: boardName, home });
  deps.host = host;
  const result = await setup(deps);
  const team = await deps.oidc().then((token) => projectOf(token)?.team, () => undefined);
  const local = isLocal(deps.env);
  const origin = `${local ? "http" : "https"}://${host ?? deps.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost"}`;
  let running: Running | null = null;
  if (!result.open && result.found.me && progress(result.steps).running) {
    // The threads the GitHub sync labels as pull requests, in this factory's channels: their roots, one
    // per thread however many replies it has. One more read, only once it runs.
    const pulls = await deps.threads({ channel: `${home}/`, label: ["pr"], limit: READ }).catch(() => []);
    const rsi = channel("rsi");
    running = {
      overview: overview(result.found.recent, pulls, result.found.me.principal, new Date(), READ),
      repos: Object.entries(repoChannels).map(([repo, to]) => ({ repo, channel: to })),
      ask: { channel: rsi, slack: mirrorOf(slackChannels, rsi), waiting: result.found.waiting },
      join: joinPrompt({ origin, team, board: boardName, home, repo: ownRepo(deps.env) }),
      first: result.found.first,
    };
  }
  return { result, inspect: inspectCommand(team, boardName), origin, local, running };
}
