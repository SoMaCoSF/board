import type { Board, MessageView } from "@vercel/board";
import { byAgent } from "../agent/lib/identity.ts";
import { FIRST_TASK_LABEL, FIRST_TASK_PATH, firstTask, type FirstTask } from "./first-task.ts";
import { githubScope, ownRepo } from "./github.ts";
import { projectOf, type Project } from "./project.ts";

// The launcher's steps: each is a short list of tasks, checked from this deployment as it is now.
// Nothing here writes anything.

/** Where a task sends you: a page of the dashboard, or a file on GitHub. */
export type Link = { href: string; label: string };

/** What helps do a task: one short line, a link that reads on after it, and the commands to run. */
export type Help = { hint?: string; link?: Link; commands?: string[]; action?: Action };

/** Something the page does when asked, with a POST to one of its own routes. */
export type Action = { label: string; path: string };

/**
 * One task of a step, named for what to do ("Create a GitHub connector") whether it's done or not. A
 * name in its label (a channel, a repo, a connector) goes in backticks, and stands out on the page.
 */
export type Task = { label: string; done: boolean } & Help;

export type StepId = "vercel" | "github" | "slack" | "try";

/** What Vercel Connect needs to mint a GitHub token for some repos alone. */
type Scope = NonNullable<ReturnType<typeof githubScope>>;

/** A step is done once each of its tasks is. An optional one never holds up the rest. */
export type Step = { id: StepId; title: string; optional?: boolean; tasks: Task[] };

export const isDone = (step: Step) => step.tasks.every((task) => task.done);

/** What the launcher shows: its steps, or while strangers can open this deployment, only how to protect it. */
export type Setup = { open: false; steps: Step[]; found: Found } | { open: true; task: Task };

/** This deployment on its board: who it writes as, and what it may do there, by channel pattern. */
export type Me = { principal: string; can: Record<string, readonly string[]> };

/**
 * What the checks came across on the way, for the page to show once the factory runs: this
 * deployment on its board (null when it can't use it), the latest messages in its channels, how
 * many repos its GitHub app is on that come into no channel (null when that couldn't be told), and
 * where its first task stands (null when there's none to offer).
 */
export type Found = { me: Me | null; recent: MessageView[]; waiting: number | null; first: FirstTask };

/** How many messages one read of the factory's channels asks for. */
export const READ = 200;

/** Where setup stands: how many of the steps that aren't optional are done, and whether that's all of them. */
export function progress(steps: Step[]): { done: number; of: number; running: boolean } {
  const required = steps.filter((step) => !step.optional);
  const done = required.filter(isDone).length;
  return { done, of: required.length, running: done === required.length };
}

/** What the launcher says first, as a page and as markdown. */
export function headline(setup: Setup): { title: string; lede: string } {
  if (setup.open) return { title: "Protect this deployment first", lede: "The setup shows once only your team can open this page." };
  return progress(setup.steps).running
    ? { title: "Your software factory is running", lede: "Bring it issues, threads, and questions." }
    : { title: "Set up your software factory", lede: "An agent that takes your team's issues to pull requests." };
}

type Env = Record<string, string | undefined>;

/** What the board syncs, as its route configures it: the checks look for these. */
export type Synced = {
  connectors: { github: string; slack: string };
  repoChannels: Record<string, string>;
  slackChannels: Record<string, string>;
  /** The board's name, or null for the team's default board. */
  board: string | null;
  /** This factory's own channel on the board: it hears that one and the ones under it. */
  home: string;
};

/** What the checks reach: the environment, the network, and the board. Tests pass their own. */
export type Deps = {
  env: Env;
  synced: Synced;
  /** The host the checks were asked on: what strangers could reach. Production's when unknown. */
  host?: string | null;
  fetch: typeof fetch;
  /** This deployment's OIDC token. */
  oidc(): Promise<string>;
  /** A Connect connector's app token, or with `scope`, one for those GitHub repos alone. */
  connect(connector: string, scope?: Scope): Promise<string>;
  /** AI Gateway's balance, in dollars. */
  credits(): Promise<number>;
  /** Who this deployment is on its board, and what it may do there, by channel pattern. Rejects with the board's own error when it can't use it. */
  me(): Promise<Me>;
  /** The board's latest messages in a channel, newest last. */
  messages(query: { channel: string; limit: number }): Promise<MessageView[]>;
  /** The roots of the latest threads in a channel that carry a label, one per thread however many replies it has, the last active last. */
  threads(query: { channel: string; label: string[]; limit: number }): Promise<MessageView[]>;
  /** A file of this factory as it was deployed, by its path from the project's root, to link to its lines. Nothing when it can't be read. */
  source(file: string): string | undefined;
};

const TITLES: Record<StepId, string> = { vercel: "Vercel", github: "GitHub", slack: "Slack", try: "Try it" };

const step = (id: StepId, tasks: Task[], optional = false): Step => ({ id, title: TITLES[id], ...(optional ? { optional } : {}), tasks });

const done = (label: string, help: Help = {}): Task => ({ label, done: true, ...help });
const todo = (label: string, help: Help = {}): Task => ({ label, done: false, ...help });

/** Names, as a label carries them. */
const named = (...names: string[]) => names.map((name) => `\`${name}\``).join(", ");

/** One command that creates a connector for this project and sends its webhooks to the board, from any directory. */
const createConnector = (service: "github" | "slack", connector: string, project: Project) =>
  `vercel connect create ${service} --name ${connector.split("/")[1] ?? "factory"} --triggers --trigger-project ${project?.name ?? "<project>"} --trigger-path /api/board/webhooks/${service}${project ? ` --scope ${project.team}` : ""}`;

/**
 * A connector that's on this team for another project: Connect refuses this project its tokens, and
 * refuses to create it again. So the task is to attach it, with this project as one of the places its
 * webhooks go, or to give this factory's another name.
 */
const taken = (error: unknown) => (error as { code?: string } | null)?.code === "forbidden";

function attach(deps: Deps, service: "github" | "slack", connector: string, project: Project): Task {
  return todo(`Attach ${named(connector)} to this project`, {
    hint: "It's on this team for another project.",
    ...sourceLink(deps, FACTORY_FILE, "Use another name", (lines) => lines.findIndex((line) => line.startsWith("export const connectors"))),
    commands: [`vercel connect attach ${connector} --triggers --trigger-path /api/board/webhooks/${service}${project ? ` --project ${project.name} --scope ${project.team}` : ""}`],
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);

/** Where the project's settings are, from its OIDC token's claims. */
function dashboard(project: Project) {
  const base = project ? `https://vercel.com/${project.team}/${project.name}` : "https://vercel.com/dashboard";
  return { base, settings: (path: string) => (project ? `${base}/settings/${path}` : base), team: project ? `https://vercel.com/${project.team}` : base };
}

/**
 * Whether `host` turns strangers away, or why that couldn't be told: asked from outside, without
 * credentials. It asks for a static file, so an open deployment answers without rendering a page that
 * asks again.
 */
export async function closed(host: string | undefined, request: typeof fetch): Promise<boolean | Error> {
  if (!host) return new Error("no host to check");
  const status = await request(`https://${host}/icon.svg`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(
    (response) => response.status,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  if (status instanceof Error) return status;
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

/** Signing in on your machine. */
const signIn = () => todo("Link this directory, then restart the dev server", { commands: ["vercel link", "vercel env pull"] });

/** Your machine: `vercel env pull` writes VERCEL_ENV=development, so that counts too. */
export const isLocal = (env: Env) => !env.VERCEL_ENV || env.VERCEL_ENV === "development";

/** The files a person edits, from the project's root: the repos and Slack channels the board syncs, and beside them its connectors. */
export const CHANNELS_FILE = "app/api/board/[[...path]]/channels.ts";
export const FACTORY_FILE = "app/api/board/[[...path]]/factory.ts";

/**
 * One of those files in this factory's own repo on GitHub, on the branch it was deployed from, opened
 * on the line `find` picks (counted from 0, -1 for none). People edit them, so the line is looked up
 * in what was deployed, never remembered; when it isn't found, the link opens the file. Nothing off a
 * deployment from Git.
 */
function sourceLink(deps: Deps, file: string, label: string, find: (lines: string[]) => number): { link?: Link } {
  const own = ownRepo(deps.env);
  if (!own) return {};
  const source = deps.source(file);
  const line = (source === undefined ? -1 : find(source.split("\n"))) + 1;
  const path = file.split("/").map(encodeURIComponent).join("/");
  return { link: { href: `https://github.com/${own}/blob/${deps.env.VERCEL_GIT_COMMIT_REF || "main"}/${path}${line ? `#L${line}` : ""}`, label } };
}

/** The command that opens the board in a browser, as whoever runs it: on `team`, when it's known, and by its name when it has one. */
export const inspectCommand = (team: string | undefined, board: string | null) =>
  `npx @vercel/board inspect${team ? ` --scope ${team}` : ""}${board ? ` --name ${board}` : ""}`;

/** The steps, in order. While strangers can open this deployment, or that can't be told, only how to protect it. */
export async function setup(deps: Deps): Promise<Setup> {
  const local = isLocal(deps.env);
  const token = await deps.oidc().catch(() => null);
  const project = token ? projectOf(token) : null;
  if (!local) {
    const shut = await closed(deps.host ?? deps.env.VERCEL_PROJECT_PRODUCTION_URL, deps.fetch);
    if (shut instanceof Error) return { open: true, task: todo("Couldn't check that this deployment is protected", { hint: message(shut) }) };
    if (!shut) {
      const link = { href: dashboard(project).settings("deployment-protection"), label: "Open Deployment Protection" };
      return { open: true, task: todo("Turn on Vercel Authentication for all deployments", { link }) };
    }
  }
  const vercel = await vercelStep(deps, local, project);
  const found: Found = { me: vercel.me, recent: [], waiting: null, first: null };
  const [connected, mirrored] = [githubStep(deps, project, found), slackStep(deps, project)];
  const [github, slack, tryIt] = await Promise.all([connected, mirrored, tryStep(deps, project, found, connected, mirrored)]);
  return { open: false, steps: [vercel.step, github, slack, tryIt], found };
}

/** Protected, on the team's board, with AI Gateway. `me` is this project on the board, or null when it can't use it. */
async function vercelStep(deps: Deps, local: boolean, project: Project): Promise<{ step: Step; me: Me | null }> {
  const links = dashboard(project);
  const signedOut = local && !deps.env.VERCEL_OIDC_TOKEN;
  const tasks: Task[] = [];
  if (!local) {
    tasks.push(done("Turn on Deployment Protection"));
    if (!project) {
      tasks.push(todo("Turn on OIDC Federation, then redeploy", { link: { href: links.settings("security"), label: "Open Security settings" } }));
      return { step: step("vercel", tasks), me: null };
    }
  }

  // Signed out on your machine: said once, here, whatever else works. The board can answer through
  // your own login while Connect and AI Gateway still wait on the project's token.
  if (signedOut) tasks.push(signIn());

  // The board is the team's, in Vercel's API. A team has one once someone on it has opened it.
  const OPEN_BOARD = "Open the team's board once";
  const access = await deps.me().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (access instanceof Error) {
    const refused = ["board_not_granted", "no_board"].includes((access as { code?: string }).code ?? "");
    if (signedOut) tasks.push(todo(OPEN_BOARD));
    else if (refused) tasks.push(todo(OPEN_BOARD, { commands: [inspectCommand(project?.team, deps.synced.board)] }));
    else tasks.push(todo("Couldn't reach the team's board", { hint: message(access) }));
  } else {
    tasks.push(done(OPEN_BOARD));
    // A board lets every project on its team sync unless someone narrowed its grants: then it's theirs to widen.
    const syncs = Object.values(access.can).some((can) => can.includes("sync"));
    if (!syncs) tasks.push(todo("Let this project sync on the board", { hint: "Its grants were narrowed. Whoever manages the board can widen them." }));
  }

  const balance = await deps.credits().catch((error: unknown) => error);
  // A prepaid team's balance runs down to zero; a team billed for usage shows it as negative.
  const CREDITS = "Add AI Gateway credits";
  if (typeof balance === "number" && balance !== 0) tasks.push(done(CREDITS));
  else if (balance === 0) tasks.push(todo(CREDITS, { link: { href: `${links.team}/~/ai`, label: "Open AI Gateway" } }));
  else if (signedOut) tasks.push(todo(CREDITS));
  else tasks.push(todo("Couldn't reach AI Gateway", { hint: message(balance) }));

  return { step: step("vercel", tasks), me: access instanceof Error ? null : access };
}

type Repo = { full_name: string };

/** The connector, the repos its app is on, and among them this factory's own, which the agent changes to improve itself. */
async function githubStep(deps: Deps, project: Project, found: Found): Promise<Step> {
  const connector = deps.synced.connectors.github;
  const own = ownRepo(deps.env);
  const CONNECT = "Create a GitHub connector";
  const INSTALL = "Install its app on your repos";
  const write = (repo: string) => `Let the app write to ${named(repo)}`;
  const token = await deps.connect(connector).catch((error: unknown) => error);
  if (typeof token !== "string") {
    // Signed out on your machine: the Vercel step says how to sign in.
    if (isLocal(deps.env) && !deps.env.VERCEL_OIDC_TOKEN) return step("github", [todo(CONNECT), todo(INSTALL)]);
    // The connector is there, and its app is on nothing yet.
    if (token instanceof Error && token.name === "ConnectorInstallationRequiredError") return step("github", [done(CONNECT), todo(INSTALL)]);
    if (taken(token)) return step("github", [attach(deps, "github", connector, project), todo(INSTALL)]);
    return step("github", [todo(CONNECT, { commands: [createConnector("github", connector, project)] }), todo(INSTALL)]);
  }
  const tasks: Task[] = [done(CONNECT)];

  const api = (path: string, init: RequestInit = {}) =>
    deps.fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
  type Listed = { total_count: number; repositories: Repo[] };
  const read: [Listed, string | null] | Error = await Promise.all([
    api("/installation/repositories?per_page=100").then(async (response) => {
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      return (await response.json()) as Listed;
    }),
    api("/graphql", { method: "POST", body: JSON.stringify({ query: "query { viewer { login } }" }) })
      .then(async (response) => ((await response.json()) as { data?: { viewer?: { login?: string } } }).data?.viewer?.login ?? null)
      .catch(() => null),
  ]).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (read instanceof Error) return step("github", [...tasks, todo("Couldn't list the app's repos", { hint: message(read) })]);

  const [{ total_count, repositories }, viewer] = read;
  const app = viewer?.replace(/\[bot\]$/, "") ?? null;
  const install = app ? { link: { href: `https://github.com/apps/${app}/installations/new`, label: "Configure the app" } } : {};
  if (total_count === 0) return step("github", [...tasks, todo(INSTALL, install)]);
  // Installed but in no channel: the board drops their PRs and issues (matched as GitHub writes them).
  // How many, and not which: the app's repos are read as the app, and whoever can open the deployment
  // sees this page, whatever they can see on GitHub.
  const mapped = deps.synced.repoChannels;
  const off = total_count > repositories.length ? [] : repositories.filter((repo) => !(repo.full_name in mapped));
  found.waiting = total_count > repositories.length ? null : off.length;
  const several = off.length > 1;
  const unmapped = `${off.length} ${several ? "repos" : "repo"} with the app ${several ? "aren't" : "isn't"} on the board yet.`;
  // The link opens where the map of repos starts.
  const map = sourceLink(deps, CHANNELS_FILE, several ? "Add them" : "Add it", (lines) => lines.findIndex((line) => line.startsWith("export const repoChannels")));
  tasks.push(done(INSTALL, off.length ? { hint: unmapped, ...map } : {}));
  if (!own) return step("github", tasks);

  const WHY = "So the agent can change its own code.";
  const repo = repositories.find((candidate) => candidate.full_name.toLowerCase() === own.toLowerCase());
  // GitHub listed a first page only, and this repo isn't on it.
  if (!repo && total_count > repositories.length) return step("github", [...tasks, todo(`Check that the app is on ${named(own)}`, { hint: WHY, ...install })]);
  if (!repo) return step("github", [...tasks, todo(`Install the app on ${named(own)}`, { hint: WHY, ...install })]);
  // GitHub lists an app's repos with every permission false, so ask for what the agent's turns ask
  // for (agent/lib/credentials.ts): a token for this repo alone, here one that can write to it, which
  // GitHub only issues when the app may.
  const writable = await deps.connect(connector, githubScope([repo.full_name], ["contents:write"])!).catch((error: unknown) => error);
  if (typeof writable !== "string") return step("github", [...tasks, todo(write(own), { hint: WHY, ...install })]);
  return step("github", [...tasks, done(write(own))]);
}

async function slackStep(deps: Deps, project: Project): Promise<Step> {
  const connector = deps.synced.connectors.slack;
  const wanted = Object.keys(deps.synced.slackChannels);
  const CONNECT = "Create a Slack connector";
  // What the channel is for, and the line that names it, to name another: the entry that starts with
  // its name in quotes, or the map's first entry, whose name is put together from the project's.
  const names = (lines: string[]) => {
    const quoted = lines.findIndex((line) => wanted.some((name) => [`"${name}"`, `'${name}'`].some((key) => line.trimStart().startsWith(key))));
    if (quoted !== -1) return quoted;
    const map = lines.findIndex((line) => line.startsWith("export const slackChannels"));
    const first = map === -1 ? -1 : lines.findIndex((line, i) => i > map && line.trim() !== "" && !line.trimStart().startsWith("//"));
    return first !== -1 && !lines[first]!.startsWith("}") ? first : -1;
  };
  const INVITE = (channels: string[]) => `Invite the app to ${named(...channels)}`;
  const invite = (channels: string[], command?: string): Task =>
    todo(INVITE(channels), { hint: "Where the factory updates itself.", ...sourceLink(deps, CHANNELS_FILE, "Change the channel", names), ...(command ? { commands: [command] } : {}) });
  const token = await deps.connect(connector).catch((error: unknown) => error);
  if (typeof token !== "string") {
    if (isLocal(deps.env) && !deps.env.VERCEL_OIDC_TOKEN) return step("slack", [todo(CONNECT), invite(wanted)], true);
    // The board already syncs through this connector, and picks it up within a minute of its attach: no redeploy.
    if (taken(token)) return step("slack", [attach(deps, "slack", connector, project), invite(wanted)], true);
    return step("slack", [todo(CONNECT, { commands: [createConnector("slack", connector, project)] }), invite(wanted)], true);
  }
  const slack = async <T>(method: string, query = "") => {
    const response = await deps.fetch(`https://slack.com/api/${method}${query}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const data = (await response.json()) as T & { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack's ${method}: ${data.error ?? response.status}`);
    return data;
  };
  type Checked = [{ team: string; user: string }, { channels: { id: string; name: string }[] }];
  const checked: Checked | Error = await Promise.all([
    slack<Checked[0]>("auth.test"),
    // Public channels only: Connect's Slack app can read those (channels:read), not private ones (groups:read).
    slack<Checked[1]>("users.conversations", "?types=public_channel&exclude_archived=true&limit=200"),
  ]).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (checked instanceof Error) return step("slack", [done(CONNECT), todo("Couldn't ask Slack which channels the app is in", { hint: message(checked) })], true);
  const [who, mine] = checked;
  const missing = wanted.filter((name) => !mine.channels.some((candidate) => candidate.id === name || candidate.name === name.replace(/^#/, "")));
  if (missing.length) return step("slack", [done(CONNECT), invite(missing, `/invite @${who.user}`)], true);
  return step("slack", [done(CONNECT), done(INVITE(wanted))], true);
}

/** The Slack channel that mirrors a board channel, by its name. One mapped by its ID has no name to say, so it's none. */
export const mirrorOf = (slackChannels: Record<string, string>, channel: string): string | null =>
  Object.keys(slackChannels).find((name) => name.startsWith("#") && slackChannels[name] === channel) ?? null;

/**
 * `github` and `slack` are those steps: the first task needs the first one done, since it's a pull
 * request in the factory's own repo, and once the second is, the factory is asked things there.
 */
async function tryStep(deps: Deps, project: Project, found: Found, github: Promise<Step>, slack: Promise<Step>): Promise<Step> {
  const { me } = found;
  const FIRST = "Give it its first task";
  const REPLY = "Get a reply from the agent";
  // The Vercel step says how to open the board: nothing to try until then.
  if (!me) return step("try", [todo(FIRST), todo(REPLY)]);
  // The factory's channels, in one read: its own and the ones under it.
  const recent: MessageView[] | Error = await deps.messages({ channel: `${deps.synced.home}/`, limit: READ }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (recent instanceof Error) return step("try", [todo("Couldn't read the board", { hint: message(recent) }), todo(REPLY)]);
  found.recent = recent;
  // Something was asked of it once anything is in its channels: a person's message, an issue, or its
  // first task's thread, which it opens itself. Its reply is what it says in a thread, not that opening.
  const asked = recent.length > 0;
  const replied = recent.some((m) => m.re !== null && byAgent(m.by, me.principal));
  // The first task is a pull request in the factory's own repo, so it's offered once the app can write there.
  found.first = isDone(await github) ? firstTask(deps.source("README.md"), recent) : null;
  // Its thread may be older than what one read brings: before offering it again, ask for it by its label.
  if (found.first === "offer") {
    const started = await deps.threads({ channel: `${deps.synced.home}/`, label: [FIRST_TASK_LABEL], limit: 1 }).catch(() => []);
    found.first = firstTask(deps.source("README.md"), started) ?? "offer";
  }
  // Where people ask it things: where the factory changes itself, in Slack once its channel is mirrored there.
  const rsi = `${deps.synced.home}/rsi`;
  const mirror = mirrorOf(deps.synced.slackChannels, rsi);
  const where = mirror && isDone(await slack) ? mirror : rsi;
  const start: Help =
    found.first === "offer"
      ? { hint: `It makes the README yours. Or ask it anything in ${where}.`, action: { label: "Start", path: FIRST_TASK_PATH } }
      : { hint: `Ask it anything in ${where}.`, commands: [inspectCommand(project?.team, deps.synced.board)] };
  return step("try", [asked ? done(FIRST) : todo(FIRST, start), replied ? done(REPLY) : todo(REPLY)]);
}

/** What the checks ask the board, as this deployment. */
export const boardDeps = (board: Board): Pick<Deps, "me" | "messages" | "threads"> => ({
  me: async () => {
    const { principal, can } = await board.me();
    return { principal, can };
  },
  messages: async (query) => (await board.messages(query)).messages,
  threads: async (query) => (await board.threads(query)).threads.map((thread) => thread.message),
});

/** The checks' real dependencies, loaded only when the launcher runs. */
export async function liveDeps(board: Pick<Deps, "me" | "messages" | "threads">, synced: Synced): Promise<Deps> {
  const [{ getVercelOidcToken }, { getToken }, { gateway }, { readFileSync }, { join }] = await Promise.all([
    import("@vercel/oidc"),
    import("@vercel/connect"),
    import("ai"),
    import("node:fs"),
    import("node:path"),
  ]);
  return {
    env: process.env,
    synced,
    fetch,
    oidc: () => getVercelOidcToken(),
    connect: (connector, scope) => getToken(connector, { subject: { type: "app" }, ...(scope ? { authorizationDetails: scope } : {}) }),
    credits: async () => Number((await gateway.getCredits()).balance),
    me: board.me,
    messages: board.messages,
    threads: board.threads,
    // next.config.ts keeps the files the launcher links to in every route's function.
    source: (file) => {
      try {
        return readFileSync(join(process.cwd(), file), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
