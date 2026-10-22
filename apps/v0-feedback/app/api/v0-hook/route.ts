import { v0 } from "v0";
import { replies } from "@/app/api/board/[[...path]]/route";

// v0 calls this when a reply in a chat the board started finishes (a chat-scoped
// webhook, registered in v0.ts). v0 doesn't sign deliveries, so the body is only a
// nudge: the key filters out strangers, and the message is re-read from v0 with the
// deployment's OIDC token, which only reaches chats this project created. A delivery
// only records the reply (`replies.ts`), so retries and replays don't read it again.

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
  await replies.finished({ chatId, messageId });
  return Response.json({ ok: true });
}
