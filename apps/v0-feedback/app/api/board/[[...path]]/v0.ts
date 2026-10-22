import { v0 } from "v0";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { BoardClient } from "vboard/client";

// A v0 chat per report, created with the deployment's Vercel OIDC token. The project's
// git link gives each chat its own v0/vboard-<chatId> branch on vercel/v0, and
// credentialAccess.github (vercel/v0#30977) lets its gh open the pull request.

/** The API only offers v0's own models: v0-mini, v0-pro (its default), v0-max, v0-max-fast. */
const MODEL = { modelId: "v0-max", imageGenerations: false } as const;

const TASK = {
  bug: "Here's a bug report about v0, Vercel's AI app builder. Find the cause and make the smallest fix.",
  feature: "Here's a feature request for v0, Vercel's AI app builder. Build the smallest version of it worth shipping.",
};

/** What v0 does with its change. The git remote is v0's proxy, so gh needs the repo spelled out. */
const DELIVER = `When you have a change worth reviewing, commit and push it to your current branch, then open a draft pull request with gh pr create -R vercel/v0 --draft --head "$(git branch --show-current)" --base main, with the source link below in its body. Then run git blame on the lines you changed (on main) to find who knows this code best, skipping bots. In your last reply, mention the pull request and that person's email. If nothing is worth changing, say why.`;

/** Starts the chat and returns as soon as v0 accepts it: the work keeps going in v0. */
export async function startV0({ kind, text, source }: { kind: "bug" | "feature"; text: string; source: string | null }) {
  const message = `${TASK[kind]}\n\n${text}\n\n${DELIVER}${source ? `\n\nSource: ${source}` : ""}`;
  const chat = await v0.chats.createAsync({
    message,
    modelConfiguration: MODEL,
    privacy: "team-edit",
    // The published SDK only types sharedNpm; the API takes github too.
    credentialAccess: { github: true } as { sharedNpm?: boolean },
    metadata: { from: "vboard", ...(source ? { source } : {}) },
  });
  if (chat.error) throw new Error(`v0 createAsync: ${JSON.stringify(chat.error)}`);
  const chatId = chat.data.chatId;
  await watch(chatId);
  return { id: chatId, url: `https://v0.app/chat/${chatId}` };
}

/**
 * Asks v0 to tell /api/v0-hook when this chat's replies finish (vercel/v0#30982, flagged
 * on for Vercel teams). If it fails, the report just doesn't get a follow-up.
 */
async function watch(chatId: string) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const key = process.env.V0_HOOK_KEY;
  if (!host || !key) return;
  const url = new URL(`https://${host}/api/v0-hook`);
  url.searchParams.set("key", key);
  // The board's production deployment is behind Vercel Authentication.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) url.searchParams.set("x-vercel-protection-bypass", bypass);
  const hook = await v0.webhooks
    .create({ name: `vboard ${chatId}`, events: ["message.finished"], url: url.toString(), chatId })
    .catch((error: unknown) => ({ error }));
  if (hook.error) console.warn("v0 webhook not registered", chatId, JSON.stringify(hook.error));
}

const Outcome = z.object({
  state: z
    .enum(["pr", "no-change", "working"])
    .describe("pr: it opened a pull request. no-change: it finished and decided nothing was worth changing. working: it isn't done yet (stopped mid-task, about to continue, or failed partway)."),
  pr: z.string().nullable().describe("The pull request URL from the gh output or the reply, or null"),
  owner: z.string().nullable().describe("The email of the person it found knows this code best, or null"),
  summary: z.string().describe("One short sentence on what it did, or why it changed nothing"),
});

/** Reads a finished reply and, once v0 is done, labels its report with what it did. */
export async function readReply({ chatId, messageId }: { chatId: string; messageId: string }, board: BoardClient) {
  const [report] = (await board.messages({ channel: "feedback", label: { v0: chatId } })).messages;
  if (!report || report.labels.v0state === "done") return;
  const message = await v0.messages.get({ chatId, messageId });
  if (message.error) throw new Error(`v0 messages.get: ${JSON.stringify(message.error)}`);

  // The whole reply, tool calls included: gh prints the pull request URL there.
  const reply = JSON.stringify(message.data.content ?? "").slice(-30_000);
  const { output } = await generateText({
    model: "openai/gpt-6-luna",
    output: Output.object({ schema: Outcome }),
    system:
      "You read the final message of a coding agent (v0) that was asked to fix a reported issue in the vercel/v0 repo, open a draft pull request with gh, and name who knows the changed code best. Say what happened.",
    prompt: reply,
  });
  if (output.state === "working") return;
  const pr = output.pr && /^https:\/\/github\.com\/vercel\/v0\/pull\/\d+$/.test(output.pr) ? output.pr : null;
  await board.label(report.id, {
    set: { v0state: "done", summary: output.summary.slice(0, 300), ...(pr ? { pr } : {}), ...(output.owner?.includes("@") ? { owner: output.owner } : {}) },
  });
}
