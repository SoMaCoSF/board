import type { MessageView } from "@vercel/board";
import { NAME } from "../agent/lib/identity.ts";
import { githubScope, ownRepo } from "./github.ts";

// The launcher's steps: each checks what the factory needs, from this deployment, and says what to do
// while it isn't there. Nothing here writes anything.

export type Status = "done" | "todo" | "waiting" | "skipped" | "locked" | "error";

/** One thing to do: a line, then each command in its own box, or a link. */
export type Fix = { text: string; commands?: string[]; link?: { href: string; label: string } };

export type StepId = "vercel" | "github" | "slack" | "try";

/** What Vercel Connect needs to mint a GitHub token for some repos alone. */
type Scope = NonNullable<ReturnType<typeof githubScope>>;

export type Step = {
  id: StepId;
  title: string;
  /** An optional step never blocks the ones after it. */
  optional?: boolean;
  status: Status;
  /** What the check found, in a line. */
  summary: string;
  /** What it found, as label and value. */
  rows?: [label: string, value: string][];
  /** What to do, in order, while it isn't done. */
  fix?: Fix[];
};

type Env = Record<string, string | undefined>;

/** What the board syncs, as its route configures it: the checks look for these. */
export type Synced = { connectors: { github: string; slack: string }; repoChannels: Record<string, string>; slackChannels: Record<string, string> };

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
  /** The board's latest messages in a channel, newest last. */
  messages(query: { channel: string; limit: number }): Promise<MessageView[]>;
};

const TITLES: Record<StepId, string> = { vercel: "Vercel", github: "GitHub", slack: "Slack", try: "Try it" };

const step = (id: StepId, rest: Omit<Step, "id" | "title">): Step => ({ id, title: TITLES[id], ...rest });

/** One command that creates a connector for this project and sends its webhooks to the board, from any directory. */
const createConnector = (service: "github" | "slack", connector: string, project: Project) =>
  `vercel connect create ${service} --name ${connector.split("/")[1] ?? "factory"} --triggers --trigger-project ${project?.name ?? "<project>"} --trigger-path /api/board/webhooks/${service}${project ? ` --scope ${project.team}` : ""}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);

type Project = { team: string; name: string } | null;

/** The project a token names: its team's slug and its own name, or null when it doesn't read as one. */
function projectOf(jwt: string): Project {
  try {
    const { owner, project } = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
    return typeof owner === "string" && typeof project === "string" ? { team: owner, name: project } : null;
  } catch {
    return null;
  }
}

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


const SIGN_IN: Fix = { text: "Link this directory and pull its environment, then restart the dev server.", commands: ["vercel link", "vercel env pull"] };

/** Every step, in order. Until this deployment is known to turn strangers away, the rest show only their titles. */
export async function setup(deps: Deps): Promise<Step[]> {
  const local = !deps.env.VERCEL_ENV;
  const token = await deps.oidc().catch(() => null);
  const project = token ? projectOf(token) : null;
  const vercel = await vercelStep(deps, local, project);
  // Open, or not known to be closed: anyone may be reading.
  if (!local && (vercel.status === "locked" || vercel.status === "error")) {
    const rest: StepId[] = ["github", "slack", "try"];
    return [{ ...vercel, status: vercel.status === "locked" ? "todo" : "error" }, ...rest.map((id) => step(id, { status: "locked", summary: "", optional: id === "slack" }))];
  }
  const [github, slack, tryIt] = await Promise.all([githubStep(deps, project), slackStep(deps, project), tryStep(deps)]);
  return [vercel, github, slack, tryIt];
}


/**
 * Deployed, protected, with its storage and AI Gateway. An open production comes back `locked`, so
 * `setup()` shows nothing else until it's closed.
 */
async function vercelStep(deps: Deps, local: boolean, project: Project): Promise<Step> {
  const links = dashboard(project);
  const rows: [string, string][] = [];
  const fix: Fix[] = [];

  if (!local) {
    if (!project) {
      return step("vercel", {
        status: "error",
        summary: "This deployment can't get an OIDC token.",
        fix: [{ text: "Turn on OIDC Federation, then redeploy.", link: { href: links.settings("security"), label: "Security" } }],
      });
    }
    const shut = await closed(deps.host ?? deps.env.VERCEL_PROJECT_PRODUCTION_URL, deps.fetch);
    if (shut instanceof Error) return step("vercel", { status: "error", summary: `Couldn't check that this deployment is protected: ${message(shut)}` });
    const bypass = !!deps.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    rows.push(["protection", shut ? "on" : "off"], ["automation bypass", bypass ? "set" : "missing"]);
    const protection = { href: links.settings("deployment-protection"), label: "Deployment Protection" };
    if (!shut) {
      // Until it's closed, nothing else is checked: anyone can read this page.
      return step("vercel", {
        status: "locked",
        summary: "Anyone can open this deployment.",
        rows,
        fix: [
          { text: `Turn on Vercel Authentication for all deployments${bypass ? "" : ", and add a Protection Bypass for Automation"}.`, link: protection },
        ],
      });
    }
    if (!bypass) fix.push({ text: "Add a Protection Bypass for Automation, then redeploy.", link: protection });

    const { KV_REST_API_URL: url, KV_REST_API_TOKEN: redisToken } = deps.env;
    const redis = url && redisToken
      ? await deps
          .fetch(url, { method: "POST", headers: { authorization: `Bearer ${redisToken}` }, body: JSON.stringify(["PING"]), signal: AbortSignal.timeout(10_000) })
          .then(async (response) => (((await response.json()) as { result?: string }).result === "PONG" ? "connected" : `answered ${response.status}`), (error: unknown) => `unreachable: ${message(error)}`)
      : "missing";
    const blob = deps.env.BLOB_READ_WRITE_TOKEN || deps.env.BLOB_STORE_ID ? "connected" : "missing";
    rows.push(["redis", redis], ["blob", blob]);
    if (redis !== "connected") fix.push({ text: "Add Upstash for Redis, then redeploy.", commands: ["vercel integration add upstash/upstash-kv"] });
    if (blob !== "connected") fix.push({ text: "Add a private Blob store, then redeploy.", link: { href: `${links.base}/stores`, label: "Storage" } });
  } else {
    rows.push(["board", "local, in .a2"]);
  }

  const balance = await deps.credits().catch((error: unknown) => error);
  if (typeof balance === "number") {
    rows.push(["ai gateway", new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(balance)]);
    // A prepaid team's balance runs down to zero; a team billed for usage shows it as negative.
    if (balance === 0) fix.push({ text: "Add AI Gateway credits.", link: { href: `${links.team}/~/ai`, label: "AI Gateway" } });
  } else {
    rows.push(["ai gateway", "can't sign in"]);
    fix.push(local && !deps.env.VERCEL_OIDC_TOKEN ? SIGN_IN : { text: `AI Gateway: ${message(balance)}` });
  }

  return step("vercel", {
    status: fix.length ? "todo" : "done",
    summary: fix.length ? "" : local ? "Running locally." : "Protected, with storage and AI Gateway.",
    rows,
    ...(fix.length ? { fix } : {}),
  });
}

type Repo = { full_name: string };

/** The connector, the repos its app is on, and among them this factory's own, which the agent changes to improve itself. */
async function githubStep(deps: Deps, project: Project): Promise<Step> {
  const connector = deps.synced.connectors.github;
  const own = ownRepo(deps.env);
  const token = await deps.connect(connector).catch((error: unknown) => error);
  if (typeof token !== "string") {
    if (!deps.env.VERCEL_ENV && !deps.env.VERCEL_OIDC_TOKEN) return step("github", { status: "todo", summary: "", fix: [SIGN_IN] });
    if (token instanceof Error && token.name === "ConnectorInstallationRequiredError") {
      return step("github", { status: "todo", summary: "", fix: [{ text: `Install ${connector}'s app on your repos, this one included.` }] });
    }
    return step("github", {
      status: "todo",
      summary: "",
      fix: [{ text: "Create a GitHub connector for this project, and install its app on your repos, this one included.", commands: [createConnector("github", connector, project)] }],
    });
  }

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
  if (read instanceof Error) return step("github", { status: "error", summary: `Couldn't list the app's repos: ${message(read)}` });

  const [{ total_count, repositories }, viewer] = read;
  const app = viewer?.replace(/\[bot\]$/, "") ?? null;
  const install = app ? { href: `https://github.com/apps/${app}/installations/new`, label: "Configure the app" } : undefined;
  const shown = repositories.map((repo) => repo.full_name).slice(0, 3).join(", ") + (total_count > 3 ? `, +${total_count - 3}` : "");
  const rows: [string, string][] = [["repos", shown || "none"]];
  if (total_count === 0) return step("github", { status: "todo", summary: "", rows, fix: [{ text: "Install the app on your repos, this one included.", ...(install ? { link: install } : {}) }] });
  // Installed but in no channel: the board drops their PRs and issues (matched as GitHub writes them).
  const mapped = deps.synced.repoChannels;
  const off = total_count > repositories.length ? [] : repositories.map((repo) => repo.full_name).filter((name) => !(name in mapped));
  const unmapped = off.length
    ? ` ${off.slice(0, 2).join(", ")}${off.length > 2 ? `, +${off.length - 2}` : ""} ${off.length === 1 ? "isn't" : "aren't"} in repoChannels, so ${off.length === 1 ? "its" : "their"} PRs and issues stay off the board.`
    : "";
  if (!own) return step("github", { status: "done", summary: `Works on ${total_count === 1 ? "1 repo" : `${total_count} repos`}.${unmapped}`, rows });

  const repo = repositories.find((candidate) => candidate.full_name.toLowerCase() === own.toLowerCase());
  if (!repo && total_count > repositories.length) {
    return step("github", { status: "error", summary: `The app has over ${repositories.length} repos; couldn't find ${own} among them.`, rows });
  }
  if (!repo) {
    return step("github", { status: "todo", summary: "", rows, fix: [{ text: `Install the app on ${own} too, so the agent can change its own code.`, ...(install ? { link: install } : {}) }] });
  }
  // GitHub lists an app's repos with every permission false, so ask for what the agent's turns ask
  // for (agent/lib/credentials.ts): a token for this repo alone, here one that can write to it, which
  // GitHub only issues when the app may.
  const writable = await deps.connect(connector, githubScope([repo.full_name], ["contents:write"])!).catch((error: unknown) => error);
  if (typeof writable !== "string") {
    return step("github", {
      status: "todo",
      summary: "",
      rows: [...rows, ["write access", message(writable)]],
      fix: [{ text: `Give the app write access to ${own}, so the agent can change its own code.`, ...(install ? { link: install } : {}) }],
    });
  }
  return step("github", { status: "done", summary: `Works on ${total_count === 1 ? "1 repo" : `${total_count} repos`}, its own code included.${unmapped}`, rows });
}

async function slackStep(deps: Deps, project: Project): Promise<Step> {
  const connector = deps.synced.connectors.slack;
  const wanted = Object.keys(deps.synced.slackChannels);
  const channel = wanted.join(", ");
  const token = await deps.connect(connector).catch((error: unknown) => error);
  if (typeof token !== "string") {
    if (!deps.env.VERCEL_ENV && !deps.env.VERCEL_OIDC_TOKEN) return step("slack", { optional: true, status: "todo", summary: "", fix: [SIGN_IN] });
    // The board already syncs through this connector, and picks it up within a minute of its attach: no redeploy.
    return step("slack", {
      optional: true,
      status: "skipped",
      summary: `Mirror ${channel} into the board.`,
      fix: [
        { text: "Create a Slack connector for this project.", commands: [createConnector("slack", connector, project)] },
        { text: `Then invite the app to ${channel}.` },
      ],
    });
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
  if (checked instanceof Error) return step("slack", { optional: true, status: "error", summary: message(checked) });
  const [who, mine] = checked;
  const missing = wanted.filter((name) => !mine.channels.some((candidate) => candidate.id === name || candidate.name === name.replace(/^#/, "")));
  const rows: [string, string][] = [["workspace", who.team], ["app", `@${who.user}`]];
  if (missing.length) {
    return step("slack", { optional: true, status: "todo", summary: "", rows, fix: [{ text: `Invite the app to ${missing.join(", ")}, a public channel:`, commands: [`/invite @${who.user}`] }] });
  }
  return step("slack", { optional: true, status: "done", summary: `Mirrors ${channel}.`, rows });
}

async function tryStep(deps: Deps): Promise<Step> {
  const read: MessageView[][] | Error = await Promise.all([
    deps.messages({ channel: "dev", limit: 200 }),
    deps.messages({ channel: "dev/factory", limit: 200 }),
  ]).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (read instanceof Error) return step("try", { status: "error", summary: `Couldn't read the board: ${message(read)}` });
  const recent = read.flat();
  const heard = recent.some((m) => m.by.profile !== NAME);
  const replied = recent.some((m) => m.by.profile === NAME);
  if (heard && replied) return step("try", { status: "done", summary: "The agent is answering." });
  return step("try", { status: "waiting", summary: "", fix: [{ text: "Open an issue on one of its repos, or post on the board: open it with the command below." }] });
}

/** The checks' real dependencies, loaded only when the launcher runs. */
export async function liveDeps(read: Deps["messages"], synced: Synced): Promise<Deps> {
  const [{ getVercelOidcToken }, { getToken }, { gateway }] = await Promise.all([
    import("@vercel/oidc"),
    import("@vercel/connect"),
    import("ai"),
  ]);
  return {
    env: process.env,
    synced,
    fetch,
    oidc: () => getVercelOidcToken(),
    connect: (connector, scope) => getToken(connector, { subject: { type: "app" }, ...(scope ? { authorizationDetails: scope } : {}) }),
    credits: async () => Number((await gateway.getCredits()).balance),
    messages: read,
  };
}
