import { v0 } from "v0";
import { generateText, Output } from "ai";
import { z } from "zod";
import { feedback } from "@/app/api/board/[[...path]]/route";

// v0 calls this when a reply in a chat the board started finishes (a chat-scoped
// webhook, registered in v0.ts). v0 doesn't sign deliveries, so the body is only a
// nudge: the key filters out strangers, and the message is re-read from v0 with the
// deployment's OIDC token, which only reaches chats this project created.

const Outcome = z.object({
  state: z
    .enum(["pr", "no-change", "working"])
    .describe("pr: it opened a pull request. no-change: it finished and decided nothing was worth changing. working: it isn't done yet (stopped mid-task, about to continue, or failed partway)."),
  pr: z.string().nullable().describe("The pull request URL from the gh output or the reply, or null"),
  owner: z.string().nullable().describe("The email of the person it found knows this code best, or null"),
  summary: z.string().describe("One short sentence on what it did, or why it changed nothing"),
});

export async function POST(request: Request) {
  if (!process.env.V0_HOOK_KEY || new URL(request.url).searchParams.get("key") !== process.env.V0_HOOK_KEY) {
    return new Response("not found", { status: 404 });
  }
  const delivery = (await request.json().catch(() => null)) as {
    event?: string;
    data?: { id?: string; chatId?: string };
  } | null;
  const chatId = delivery?.data?.chatId;
  const messageId = delivery?.data?.id;
  if (delivery?.event !== "message.finished" || !chatId || !messageId) return Response.json({ ok: true });

  const message = await v0.messages.get({ chatId, messageId });
  if (message.error || message.data.role !== "assistant" || !message.data.finishReason) {
    return Response.json({ ok: true });
  }

  const board = feedback.as("v0-hook");
  const [report] = (await board.messages({ channel: "feedback", label: { v0: chatId } })).messages;
  if (!report || report.labels.v0state === "done") return Response.json({ ok: true });

  // The whole reply, tool calls included: gh prints the pull request URL there.
  const reply = JSON.stringify(message.data.content ?? "").slice(-30_000);
  const { output } = await generateText({
    model: "openai/gpt-6-luna",
    output: Output.object({ schema: Outcome }),
    system:
      "You read the final message of a coding agent (v0) that was asked to fix a reported issue in the vercel/v0 repo, open a draft pull request with gh, and name who knows the changed code best. Say what happened.",
    prompt: reply,
  });
  if (output.state === "working") return Response.json({ ok: true });
  const pr = output.pr && /^https:\/\/github\.com\/vercel\/v0\/pull\/\d+$/.test(output.pr) ? output.pr : null;
  await board.label(report.id, {
    set: { v0state: "done", summary: output.summary.slice(0, 300), ...(pr ? { pr } : {}), ...(output.owner?.includes("@") ? { owner: output.owner } : {}) },
  });
  return Response.json({ ok: true });
}
