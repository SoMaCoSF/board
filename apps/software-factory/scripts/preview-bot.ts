// Makes or retires a branch's preview bot (`app/api/board/[[...path]]/preview.ts`):
//
//   node scripts/preview-bot.ts ensure <branch>   make it, or repair its name; safe to rerun
//   node scripts/preview-bot.ts remove <branch>   turn it off and delete its connector
//   node scripts/preview-bot.ts inviter           make the bot that adds them to the channel, once
//   node scripts/preview-bot.ts tester            make the bot Pi tests a preview as in Slack, once
//
// Only a Vercel user may create, rename or delete a connector, so this runs with VERCEL_TOKEN or
// your `vc login`, never from a deployment. Connect's Slack manager (Vercel's Slack app, already
// authorized in Vercel's workspace) creates the app and installs it with no browser.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INVITER, TESTER, manifest, PREVIEW_CHANNEL, previewBot, SLACK_TEAM } from "../app/api/board/[[...path]]/preview.ts";

const TEAM = "team_TtmJZYmD3tcLBLqWOhoVawd1";
const PROJECT = "prj_Cu5qMQq8MGIQUIyWGOqgZgJPBG4z";
// Vercel's Slack app for Connect, the same for every team; `installationId` picks the workspace.
const MANAGER = "scl_5NPV4bIMQe55vqHFqCeiQ";

const token = () => {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const dirs = [join(homedir(), ".local/share/com.vercel.cli"), join(homedir(), "Library/Application Support/com.vercel.cli")];
  for (const dir of dirs)
    try {
      return JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).token as string;
    } catch {}
  throw new Error("no VERCEL_TOKEN and no `vc login`");
};

async function vercel(method: string, path: string, body?: unknown) {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", TEAM);
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url.pathname}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const connectorPath = (connector: string) => `/v1/connect/connectors/${encodeURIComponent(connector)}`;

const rename = (connector: string, appName: string) =>
  vercel("PATCH", `/v2/connect/connectors/${encodeURIComponent(connector)}`, { data: { appName } });

// Connect answers 201 even when Slack refused the install; the preview finds out when it asks
// for the bot's token. A bot a cut-short `remove` left renamed gets its name back.
async function ensure(branch: string) {
  const { connector, appName } = previewBot(branch);
  if (await vercel("GET", connectorPath(connector))) {
    await rename(connector, appName);
    console.log(`✓ ${connector} exists; named it ${appName}`);
    return;
  }
  await vercel("POST", "/v1/connect/connectors/managed/slack", {
    managerClientId: MANAGER,
    installationId: SLACK_TEAM,
    uid: connector,
    name: connector.slice("slack/".length),
    projectId: PROJECT,
    environments: ["preview"],
    input: { appName, description: manifest.description, botScopes: manifest.botScopes },
    triggers: true,
    events: manifest.events,
    // Connect sends the bot's events to the branch's newest preview, through deployment protection.
    triggerDestination: { projectId: PROJECT, branch, path: "/api/board/webhooks/slack" },
  });
  console.log(`✓ made ${connector}, @${appName}; the preview adds it to <#${PREVIEW_CHANNEL}> as @${INVITER.appName}`);
}

// Nothing Connect gives out can take an app out of Slack, so the bot is renamed to say why it
// stopped, then deleting its connector revokes its tokens. Slack renames a bot only while it is
// installed, so the name changes first. A connector attached to a project is detached first.
async function remove(branch: string) {
  const { connector, appName } = previewBot(branch);
  const path = connectorPath(connector);
  if (!(await vercel("GET", path))) {
    console.log(`✓ ${connector} is already gone`);
    return;
  }
  await rename(connector, `${appName} (closed)`);
  const attached = (await vercel("GET", `${path}/projects`)) as { projects?: { projectId: string }[] } | null;
  for (const { projectId } of attached?.projects ?? []) await vercel("DELETE", `${path}/projects/${projectId}`);
  await vercel("DELETE", path);
  console.log(`✓ ${connector} is off; remove "${appName} (closed)" under Apps in Slack`);
}

// The bots every preview shares, with no events: the inviter, which adds preview bots to the private
// channel (a person invites it once), and the tester Pi speaks as there. Production's Pi hands out the
// tester's token, so it's attached to production too.
const helpers = {
  inviter: { ...INVITER, environments: ["preview"], next: `invite it to <#${PREVIEW_CHANNEL}> once` },
  tester: { ...TESTER, environments: ["production", "preview"], next: "each preview adds it to the channel" },
};

async function helper(name: keyof typeof helpers) {
  const { connector, appName, description, botScopes, environments, next } = helpers[name];
  if (await vercel("GET", connectorPath(connector))) {
    console.log(`✓ ${connector} exists`);
    return;
  }
  await vercel("POST", "/v1/connect/connectors/managed/slack", {
    managerClientId: MANAGER,
    installationId: SLACK_TEAM,
    uid: connector,
    name: connector.slice("slack/".length),
    projectId: PROJECT,
    environments,
    input: { appName, description, botScopes },
  });
  console.log(`✓ made ${connector}, @${appName}: ${next}`);
}

const [command, branch] = process.argv.slice(2);
if (command === "inviter" || command === "tester") {
  await helper(command).catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  process.exit(0);
}
if (!branch || (command !== "ensure" && command !== "remove")) {
  console.error("usage: node scripts/preview-bot.ts ensure|remove <branch> | inviter | tester");
  process.exit(2);
}
try {
  await (command === "ensure" ? ensure : remove)(branch);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
