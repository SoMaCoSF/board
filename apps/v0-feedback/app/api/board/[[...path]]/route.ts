import { board, type WatcherContext } from "vboard";
import { slack } from "vboard/adapter-slack";
import { createSlackAdapter } from "@chat-adapter/slack";
import { connectSlackAdapter } from "@vercel/connect/chat";
import { redisHttp } from "vboard/store-redis-http";
import { vercelQueues } from "vboard/scheduler-vercel";
import { experimental_decide as decide, generateText } from "ai";
import { startV0 } from "./v0";

// The v0 feedback bot, on Vercel's Slack: people post v0 feedback in #feedback-v0-vboard.
// Each new thread gets :ack:; the ones worth addressing get a v0 chat, a :v0:, and a
// post in #feedback-v0-prs. Locally there's no VERCEL_ENV, so the board is SQLite at .a2/dev.db.
const env = process.env.VERCEL_ENV;

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

const slackCredentials = connectSlackAdapter("slack/vboard");
const slackAdapter = createSlackAdapter(slackCredentials);
const slackToken = slackCredentials.botToken;

export const { GET, POST, scheduler, client } = board({
  store: env
    ? redisHttp({
        url: process.env.KV_REST_API_URL!,
        token: process.env.KV_REST_API_TOKEN!,
        // Production's Upstash database is connected to Production only: a preview runs whatever was deployed
        // to it, and the token reaches every key whatever its prefix.
        // `-2` since A2 0.17 changed its Redis layout.
        keyPrefix: env === "production" ? "vboard-2" : `vboard-2:${env}`,
      })
    : undefined,
  scheduler: vercelQueues({ topic: "vboard" }),
  sync: {
    slack: slack({
      adapter: slackAdapter,
      client: async () =>
        slackAdapter.withBotToken(
          typeof slackToken === "function" ? await slackToken() : slackToken,
          () => slackAdapter.webClient,
        ),
      // Both are private, and the app can't look up private channels by name.
      channels: {
        C0C6FNTCRC6: "feedback", // #feedback-v0-vboard
        C0C6CCVJ48N: "v0-prs", // #feedback-v0-prs
      },
    }),
  },
  watch: {
    triage: { tail: "feedback", run: triage },
    report: { tail: "feedback --label v0state=done", when: "enters", run: report },
  },
});

/** How sure triage must be that a report is worth fixing before it starts a v0 chat. */
const WORTH = 0.7;

/** Acks a new thread, decides whether it's worth addressing, and hands the ones that are to v0. */
async function triage({ event, board }: WatcherContext) {
  const message = event.message;
  if (event.type !== "message.posted" || !message || message.re !== null) return;
  await board.react(message.id, "ack");
  const { answers } = await decide({
    model: "openai/gpt-6-luna-decisions",
    state: message.text,
    questions: {
      kind: {
        type: "choice",
        instructions: "Classify this feedback about v0, Vercel's AI app builder.",
        criteria: {
          bug: "Something is broken or behaves wrongly.",
          feature: "A request for something v0 doesn't do yet, or a concrete improvement.",
          feedback: "An opinion, praise or complaint, with nothing specific to act on.",
          noise: "Chatter or nothing to act on.",
        },
      },
      worth: {
        type: "boolean",
        instructions: "Should a coding agent try to fix or build this now?",
        criteria: {
          true: "A bug or feature specific enough to act on and small enough for a coding agent to attempt: a clear symptom or ask.",
          false: "A vague wish, a strategy question, or nothing to fix or build.",
        },
      },
    },
  });
  const kind = answers.kind.choice;
  const worth = answers.worth.probability;
  await board.label(message.id, { set: { kind, worth: worth.toFixed(2) } });
  if (worth < WORTH || (kind !== "bug" && kind !== "feature")) return;
  // A retried watcher sees the event as it was: check the thread as it is now, and
  // finish an announcement that failed after the chat started rather than start another.
  const labels = (await board.thread(message.id)).message.labels;
  if (labels.announcement) return;
  let chatId = labels.v0;
  if (!chatId) {
    chatId = (await startV0({ kind, text: message.text, source: slackLink(message.origin?.thread) })).id;
    await board.label(message.id, { set: { v0: chatId } });
    await board.react(message.id, "v0");
  }
  // Only the reports v0 takes on need words, so only they pay for a generated reason.
  const { text: reason } = await generateText({
    model: "openai/gpt-6-luna",
    system: `You triage feedback about v0, Vercel's AI app builder. In one short sentence, say why this ${kind} report is worth a coding agent's attempt.`,
    prompt: message.text,
  });
  const firstLine = message.text.split("\n")[0]!.slice(0, 140);
  const announcement = await board.post("v0-prs", {
    text: `v0 is on a ${kind}: “${quoted(firstLine)}”\n${quoted(reason)}\nhttps://v0.app/chat/${chatId}${message.origin ? `\nsource: ${slackLink(message.origin.thread)}` : ""}`,
    labels: { source: String(message.id), v0: chatId, kind },
  });
  await board.label(message.id, { set: { announcement: String(announcement.id) } });
}

/** v0 finished (labelled by /api/v0-hook): reply once in the announcement's thread with what it did. */
async function report({ event, board }: WatcherContext) {
  const labels = event.message?.labels;
  const announcement = Number(labels?.announcement);
  if (!labels || !announcement) return;
  const { pr, owner, summary } = labels;
  const text = [
    pr ? `v0 opened a draft PR: ${pr}` : `v0 finished without a PR: https://v0.app/chat/${labels.v0}`,
    summary,
    // A mention by email pings them in Slack when they're there, and reads as the email otherwise.
    owner ? `likely owner: @[${owner}]` : null,
  ].filter(Boolean).join("\n");
  await board.reply(announcement, text);
}

/**
 * Someone else's words, safe to post: a board write fails on an `@handle` it can't
 * resolve, and quoting a report shouldn't ping anyone again. A word joiner after each
 * `@` keeps the text looking the same but stops it from parsing as a mention.
 */
function quoted(text: string) {
  return text.replaceAll("@", "@⁠");
}

/** `slack:C0123:1727.1234` → a Slack permalink. */
function slackLink(target: string | undefined) {
  const [, channel, ts] = target?.split(":") ?? [];
  return channel && ts ? `https://vercel.slack.com/archives/${channel}/p${ts.replace(".", "")}` : null;
}
