import { createHash } from "node:crypto";
import type { SlackEvent } from "vboard/adapter-slack";

/**
 * A preview's own Slack bot. Production is `slack/vboard-factory` in `dev`'s channel; each
 * preview gets a bot of its own, a Slack app Connect makes and installs with no browser
 * (`scripts/preview-bot.ts`), whose events Connect sends to the branch's newest preview. Every
 * preview bot lives in #project-vboard-previews, so a preview never posts in the real channel.
 */
export const PREVIEW_CHANNEL = "C0C7P6NN8FM";

/** Vercel's Slack workspace, where Connect's Slack manager makes the bots. */
export const SLACK_TEAM = "T0CAQ00TU";

// A connector's name and a Slack app's (35 at most) both come from the branch, kept short.
const slug = (branch: string) => {
  const plain = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "branch";
  if (plain.length <= 24) return plain;
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 5);
  return `${plain.slice(0, 18).replace(/-$/, "")}-${hash}`;
};

/** The branch's bot: its Connect connector and its name in Slack. */
export const previewBot = (branch: string) => ({
  connector: `slack/vboard-preview-${slug(branch)}`,
  appName: `vboard ${slug(branch)}`,
});

/** The bot this deployment speaks as: the branch's on a preview, production's everywhere else. */
export const slackConnector = (env: NodeJS.ProcessEnv = process.env) =>
  env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF
    ? previewBot(env.VERCEL_GIT_COMMIT_REF).connector
    : "slack/vboard-factory";

/** Whose log a non-production deployment keeps: a preview's is its branch's, like its bot. */
export const previewLog = (env: NodeJS.ProcessEnv = process.env) =>
  env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF
    ? `preview:${slug(env.VERCEL_GIT_COMMIT_REF)}`
    : env.VERCEL_ENV;

/** What a preview bot is made with: production's scopes and events. */
export const manifest = {
  description: "A vboard-factory preview's own bot, in #project-vboard-previews.",
  botScopes: [
    "app_mentions:read",
    "channels:history",
    "channels:join",
    "channels:read",
    "chat:write",
    "chat:write.customize",
    "files:read",
    "files:write",
    "groups:history",
    "groups:read",
    "reactions:read",
    "reactions:write",
    "users:read",
    "users:read.email",
  ],
  events: ["app_mention", "message.channels", "message.groups", "reaction_added", "reaction_removed"],
};

/**
 * A bot can't join a private channel itself, and only a member with `groups:write` can invite
 * one. This bot is that member: invited to #project-vboard-previews once, by a person, it adds
 * each preview's bot. Connect gives a bot's token only to a deployment, so the preview asks.
 */
export const INVITER = {
  connector: "slack/vboard-previews",
  appName: "vboard previews",
  description: "Adds each vboard-factory preview's bot to #project-vboard-previews.",
  botScopes: ["groups:read", "groups:write"],
};

type SlackCall = (token: string, method: string, body: Record<string, string>) => Promise<{ ok: boolean; error?: string; user_id?: string }>;

const slackApi: SlackCall = async (token, method, body) =>
  (await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  })).json();

/** Adds the preview's bot (`token`) to the preview channel, as the inviter (`inviter`). */
export async function invitePreviewBot(token: string, inviter: string, call: SlackCall = slackApi) {
  const me = await call(token, "auth.test", {});
  if (!me.ok || !me.user_id) throw new Error(`auth.test: ${me.error}`);
  const invited = await call(inviter, "conversations.invite", { channel: PREVIEW_CHANNEL, users: me.user_id });
  if (!invited.ok && invited.error !== "already_in_channel") throw new Error(`conversations.invite: ${invited.error}`);
}

type SlackRoot = { user?: string; bot_id?: string; text?: string };

export type PreviewWeb = {
  auth: { test(): Promise<{ user_id?: string; bot_id?: string }> };
  conversations: {
    replies(args: { channel: string; ts: string; limit: number; inclusive: boolean }): Promise<{ messages?: SlackRoot[] }>;
  };
};

/**
 * Every preview bot hears every message in the shared channel, so each preview takes only its
 * own threads: one its bot started, or one whose root mentions it. The rest belong to other
 * previews, or to nobody. A thread's verdict is asked of Slack once and kept.
 */
export function ownThreads(web: () => Promise<PreviewWeb>) {
  let me: Promise<{ user: string; bot: string | undefined }> | undefined;
  const verdicts = new Map<string, Promise<boolean>>();

  // The board posts under each author's name (`chat:write.customize`), and Slack then gives the
  // message only the bot's ID, no user.
  const mine = (root: SlackRoot | undefined, { user, bot }: { user: string; bot: string | undefined }) =>
    !!root && (root.user === user || (!!bot && root.bot_id === bot) || (root.text ?? "").includes(`<@${user}>`));

  const owned = (event: SlackEvent) => {
    // `slack:<channel>:<root ts>`
    const [, channel, ts] = event.thread.split(":");
    let verdict = verdicts.get(event.thread);
    if (!verdict) {
      verdict = (async () => {
        const client = await web();
        me ??= client.auth.test().then(({ user_id, bot_id }) => {
          if (!user_id) throw new Error("auth.test named no bot user");
          return { user: user_id, bot: bot_id };
        });
        const bot = await me;
        if (event.kind === "message" && event.isRoot) return mine(event.raw as SlackRoot, bot);
        const { messages } = await client.conversations.replies({ channel, ts, limit: 1, inclusive: true });
        return mine(messages?.[0], bot);
      })();
      verdict.catch(() => {
        verdicts.delete(event.thread);
        me = undefined;
      });
      verdicts.set(event.thread, verdict);
    }
    return verdict;
  };

  return async ({ event, board }: { event: SlackEvent; board: { sync(channel: string, event: SlackEvent): Promise<unknown> } }) => {
    if (await owned(event)) await board.sync("dev", event);
  };
}
