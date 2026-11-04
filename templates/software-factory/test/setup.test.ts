import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, type Deps, type Step } from "../lib/setup.ts";

// The launcher's checks, driven as the page drives them, against a fake network: what a person sees is
// each step's status and what to do, and what the outside world sees is the requests it sends.

const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A production deployment of acme/factory with everything it needs. */
const PRODUCTION = {
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "factory.acme.dev",
  VERCEL_GIT_REPO_OWNER: "acme",
  VERCEL_GIT_REPO_SLUG: "factory",
  VERCEL_AUTOMATION_BYPASS_SECRET: "bypass",
  KV_REST_API_URL: "https://redis.test",
  KV_REST_API_TOKEN: "redis-token",
  BLOB_READ_WRITE_TOKEN: "blob-token",
};

type Routes = Record<string, (init?: RequestInit, url?: string) => Response>;

const ROUTES: Routes = {
  "https://factory.acme.dev/icon.svg": () => new Response("", { status: 401 }),
  "https://redis.test": () => json({ result: "PONG" }),
  "https://api.github.com/installation/repositories": () =>
    json({ total_count: 2, repositories: [{ full_name: "acme/factory" }, { full_name: "acme/web" }] }),
  "https://api.github.com/graphql": () => json({ data: { viewer: { login: "acme-factory" } } }),
};

/** What Connect throws for a connector that doesn't exist. */
const notFound = (connector: string) =>
  Promise.reject(Object.assign(new Error(`Connector not found: ${connector}`), { name: "ConnectError", status: 404, code: "not_found" }));


const message = (id: string, profile: string | null, re: string | null = null) =>
  ({ id, re, by: { principal: "p", profile, session: null, actor: "a" }, createdAt: "2026-11-03T00:00:00.000Z" }) as never;

function fake(options: { env?: Record<string, string | undefined>; routes?: Routes; deps?: Partial<Deps> } = {}) {
  const requests: string[] = [];
  const routes = { ...ROUTES, ...options.routes };
  const deps: Deps = {
    env: options.env ?? PRODUCTION,
    // As the board route configures it, on a deployment of acme/factory.
    synced: {
      connectors: { github: "github/factory", slack: "slack/factory" },
      repoChannels: { "acme/factory": "dev/factory" },
      slackChannels: { "#factory": "dev" },
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (!route) throw new Error(`no route for ${url}`);
      return route[1](init, url);
    }) as typeof fetch,
    oidc: async () => jwt({ owner: "acme", project: "factory" }),
    // Every connector but Slack's, which a test connects when it needs one.
    connect: async (connector) => (connector.startsWith("slack/") ? notFound(connector) : "app-token"),
    credits: async () => 5,
    messages: async () => [message("12", null), message("13", "factory", "12")],
    ...options.deps,
  };
  return { deps, requests };
}

const byId = (steps: Step[]) => Object.fromEntries(steps.map((step) => [step.id, step]));
const statuses = (steps: Step[]) => Object.fromEntries(steps.map((step) => [step.id, step.status]));
const commands = (step: Step) => (step.fix ?? []).flatMap((fix) => fix.commands ?? []);
const links = (step: Step) => (step.fix ?? []).flatMap((fix) => (fix.link ? [fix.link.href] : []));

test("a factory that's set up passes every step, with Slack left optional", async () => {
  const steps = await setup(fake().deps);
  assert.deepEqual(statuses(steps), { vercel: "done", github: "done", slack: "skipped", try: "done" });
  assert.equal(byId(steps).slack!.optional, true);
});

test("GitHub names the repos the app is on that come into no channel", async () => {
  // The app is on acme/factory, which comes into dev/factory on its own, and acme/web, which no one mapped.
  const { github } = byId(await setup(fake().deps));
  assert.equal(github!.status, "done");
  assert.equal(github!.summary, "Works on 2 repos, its own code included. acme/web isn't in repoChannels, so its PRs and issues stay off the board.");
});

test("GitHub asks Connect for a token that writes to the factory's own repo alone, as the agent's turns do", async () => {
  const asked: unknown[] = [];
  const { github } = byId(await setup(fake({ deps: { connect: async (connector, scope) => (asked.push(scope ?? null), connector.startsWith("slack/") ? notFound(connector) : "app-token") } }).deps));
  assert.equal(github!.status, "done");
  assert.deepEqual(asked.filter(Boolean), [[{ type: "github_app_installation", org: "acme", repositories: ["factory"], permissions: ["contents:write"] }]]);
});

test("GitHub isn't done until the app can write to the factory's own repo", async () => {
  // GitHub refuses a token with contents:write for an app that can't write there.
  const { github } = byId(
    await setup(fake({ deps: { connect: async (connector, scope) => (scope ? Promise.reject(new Error("GitHub installation token failed")) : connector.startsWith("slack/") ? notFound(connector) : "app-token") } }).deps),
  );
  assert.equal(github!.status, "todo");
  assert.equal(github!.fix?.[0]?.text, "Give the app write access to acme/factory, so the agent can change its own code.");
  assert.deepEqual(links(github!), ["https://github.com/apps/acme-factory/installations/new"]);
});

test("GitHub says nothing more when every repo the app is on comes in", async () => {
  const { github } = byId(
    await setup(fake({ routes: { "https://api.github.com/installation/repositories": () => json({ total_count: 1, repositories: [{ full_name: "acme/factory" }] }) } }).deps),
  );
  assert.equal(github!.summary, "Works on 1 repo, its own code included.");
});

test("an open production shows only how to protect it, and asks nothing of GitHub, Redis, or the board", async () => {
  let read = false;
  const { deps, requests } = fake({
    routes: { "https://factory.acme.dev/icon.svg": () => new Response("<svg/>", { status: 200 }) },
    deps: { messages: async () => ((read = true), []) },
  });
  const steps = await setup(deps);
  assert.deepEqual(statuses(steps), { vercel: "todo", github: "locked", slack: "locked", try: "locked" });
  assert.deepEqual(links(byId(steps).vercel!), ["https://vercel.com/acme/factory/settings/deployment-protection"]);
  assert.deepEqual(requests, ["https://factory.acme.dev/icon.svg"]);
  assert.equal(read, false);
});

test("an open preview shows only how to protect it, even while production is closed", async () => {
  const { deps, requests } = fake({
    deps: { host: "factory-git-fix-acme.vercel.app" },
    routes: { "https://factory-git-fix-acme.vercel.app/icon.svg": () => new Response("<svg/>", { status: 200 }) },
  });
  const steps = await setup(deps);
  assert.deepEqual(statuses(steps), { vercel: "todo", github: "locked", slack: "locked", try: "locked" });
  assert.deepEqual(requests, ["https://factory-git-fix-acme.vercel.app/icon.svg"]);
});

test("a protection check that fails shows nothing else, as if the deployment were open", async () => {
  const { deps, requests } = fake({ deps: { host: "unreachable.acme.dev" } });
  const steps = await setup(deps);
  assert.deepEqual(statuses(steps), { vercel: "error", github: "locked", slack: "locked", try: "locked" });
  assert.match(byId(steps).vercel!.summary, /Couldn't check that this deployment is protected/);
  assert.deepEqual(requests, ["https://unreachable.acme.dev/icon.svg"]);
});

test("a protected production without an automation bypass isn't ready, but shows the rest", async () => {
  const steps = await setup(fake({ env: { ...PRODUCTION, VERCEL_AUTOMATION_BYPASS_SECRET: undefined } }).deps);
  const { vercel, github } = byId(steps);
  assert.equal(vercel!.status, "todo");
  assert.deepEqual(links(vercel!), ["https://vercel.com/acme/factory/settings/deployment-protection"]);
  assert.equal(github!.status, "done");
});

test("without Redis, the Vercel step says how to add it, and nothing calls Redis", async () => {
  const { deps, requests } = fake({ env: { ...PRODUCTION, KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined } });
  const { vercel } = byId(await setup(deps));
  assert.equal(vercel!.status, "todo");
  assert.deepEqual(commands(vercel!), ["vercel integration add upstash/upstash-kv"]);
  assert.ok(!requests.some((url) => url.startsWith("https://redis.test")));
});

test("a GitHub connector that isn't attached says how to create and attach it, a command per box", async () => {
  const { github } = byId(await setup(fake({ deps: { connect: async () => Promise.reject(new Error("connector not found")) } }).deps));
  assert.equal(github!.status, "todo");
  assert.deepEqual(commands(github!), [
    "vercel connect create github --name factory --triggers --trigger-project factory --trigger-path /api/board/webhooks/github --scope acme",
  ]);
});

test("GitHub isn't done until the app is on the factory's own repo", async () => {
  const { github } = byId(
    await setup(
      fake({
        routes: { "https://api.github.com/installation/repositories": () => json({ total_count: 1, repositories: [{ full_name: "acme/web" }] }) },
      }).deps,
    ),
  );
  assert.equal(github!.status, "todo");
  assert.deepEqual(links(github!), ["https://github.com/apps/acme-factory/installations/new"]);
});

test("an app GitHub lists with every permission false is done once it can write", async () => {
  // How GitHub answers /installation/repositories for an app's token, whatever the app may do.
  const { github } = byId(
    await setup(
      fake({
        routes: {
          "https://api.github.com/installation/repositories": () =>
            json({ total_count: 1, repositories: [{ full_name: "acme/factory", permissions: { admin: false, push: false, pull: false } }] }),
        },
      }).deps,
    ),
  );
  assert.equal(github!.status, "done");
});

test("Slack without its connector shows how to create and attach it, and nothing to redeploy", async () => {
  const { slack } = byId(await setup(fake().deps));
  assert.equal(slack!.status, "skipped");
  assert.deepEqual(commands(slack!), [
    "vercel connect create slack --name factory --triggers --trigger-project factory --trigger-path /api/board/webhooks/slack --scope acme",
  ]);
});

/** Slack's users.conversations as Connect's Slack app gets it: channels:read, but not groups:read. */
const conversations = (...channels: { id: string; name: string }[]) => (_init?: RequestInit, url = "") =>
  url.includes("private_channel") ? json({ ok: false, error: "missing_scope", needed: "groups:read" }) : json({ ok: true, channels });

test("Slack set up without its app in the channel says to invite it, and blocks nothing", async () => {
  const { deps, requests } = fake({
    deps: { connect: async () => "app-token" },
    routes: {
      "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
      "https://slack.com/api/users.conversations": conversations({ id: "C1", name: "general" }),
    },
  });
  const steps = await setup(deps);
  const { slack } = byId(steps);
  assert.equal(slack!.status, "todo");
  assert.deepEqual(commands(slack!), ["/invite @factory"]);
  assert.ok(requests.includes("https://slack.com/api/auth.test"));
  assert.equal(steps.filter((step) => !step.optional && step.status !== "done").length, 0);
});

test("Slack's app in its channel, by name, is done", async () => {
  const { slack } = byId(
    await setup(
      fake({
        deps: { connect: async () => "app-token" },
        routes: {
          "https://slack.com/api/auth.test": () => json({ ok: true, team: "Acme", user: "factory" }),
          "https://slack.com/api/users.conversations": conversations({ id: "C2", name: "factory" }),
        },
      }).deps,
    ),
  );
  assert.equal(slack!.status, "done");
});

test("try waits until someone posts and the agent replies", async () => {
  const nothing = byId(await setup(fake({ deps: { messages: async () => [] } }).deps));
  assert.equal(nothing.try!.status, "waiting");
  const unanswered = byId(await setup(fake({ deps: { messages: async () => [message("12", null)] } }).deps));
  assert.equal(unanswered.try!.status, "waiting");
});

test("locally, the board needs nothing, and signing in is one link and one pull", async () => {
  const { deps, requests } = fake({
    env: { PORT: "3000" },
    deps: {
      oidc: async () => Promise.reject(new Error("no token")),
      credits: async () => Promise.reject(new Error("no token")),
      connect: async () => Promise.reject(new Error("The 'x-vercel-oidc-token' header is missing")),
    },
  });
  const { vercel, github } = byId(await setup(deps));
  assert.equal(vercel!.status, "todo");
  assert.deepEqual(commands(vercel!), ["vercel link", "vercel env pull"]);
  assert.deepEqual(commands(github!), ["vercel link", "vercel env pull"]);
  assert.ok(!requests.some((url) => url.includes("icon.svg")));
});

test("AI Gateway without credits says where to add them", async () => {
  const { vercel } = byId(await setup(fake({ deps: { credits: async () => 0 } }).deps));
  assert.equal(vercel!.status, "todo");
  assert.deepEqual(links(vercel!), ["https://vercel.com/acme/~/ai"]);
});

test("a team billed for AI Gateway usage, with a negative balance, is ready", async () => {
  const { vercel } = byId(await setup(fake({ deps: { credits: async () => -1194239.37 } }).deps));
  assert.equal(vercel!.status, "done");
});
