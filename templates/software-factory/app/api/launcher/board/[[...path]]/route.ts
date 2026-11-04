import { factory } from "@/app/api/board/[[...path]]/route";
import { open, sameOrigin } from "@/lib/gate";

// The launcher's chat reaches the board through here: the page is just another board handle, on
// `http()` to this route, as `vb inspect`'s page is on its proxy. It acts as `launcher`, for whoever
// is on the page, and only reads, posts, reacts, and attaches files in dev/factory (that channel
// alone, not a subtree).

// Events long-poll.
export const maxDuration = 300;

const profile = "launcher";
const chat = "dev/factory";

const refuse = (status: number, message: string, code = "forbidden") => Response.json({ error: { code, message } }, { status });

/** Whether a message's thread is in dev/factory. */
const inChannel = async (id: string) => (await factory.thread(id).catch(() => null))?.message.channel === chat;

/** Whether a file is on one of dev/factory's recent messages: the chat downloads only those. */
const inChat = async (id: string) => (await factory.messages({ channel: chat, limit: 200 })).messages.some((m) => m.attachments.some((a) => a.id === id));

async function handle(request: Request, { params }: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const url = new URL(request.url);
  if (await open(url.host)) return refuse(403, "the chat is off until this deployment is protected");
  const { path = [] } = await params;
  const route = `/${path.join("/")}`;
  const channel = url.searchParams.get("channel");
  const headers: Record<string, string> = { accept: request.headers.get("accept") ?? "application/json" };
  let body: Uint8Array<ArrayBuffer> | undefined;

  if (request.method === "GET") {
    const free = route === "/" || route === "/me";
    const listed = (route === "/messages" || route === "/threads" || route === "/events") && channel === chat;
    const one = /^\/messages\/[A-Za-z0-9_-]+$/.test(route) && (await inChannel(path[1]!));
    const file = /^\/attachments\/[A-Za-z0-9_-]+$/.test(route) && (await inChat(path[1]!));
    if (!free && !listed && !one && !file) return refuse(404, "not something the chat reads");
  } else if (request.method === "POST") {
    // Writes come only from this page: a form elsewhere can't post as the launcher.
    if (!sameOrigin(request)) return refuse(403, "the chat writes only from its own page");
    body = new Uint8Array(await request.arrayBuffer());
    headers["content-type"] = request.headers.get("content-type") ?? "application/json";
    if (route === "/messages") {
      const sent = JSON.parse(new TextDecoder().decode(body)) as { channel?: string; re?: string };
      if (sent.re ? !(await inChannel(sent.re)) : sent.channel !== chat) return refuse(403, `the chat posts only in ${chat}`);
    } else if (/^\/messages\/[A-Za-z0-9_-]+\/reactions$/.test(route)) {
      if (!(await inChannel(path[1]!))) return refuse(403, `the chat reacts only in ${chat}`);
    } else if (route === "/attachments") {
      // A file of up to 4 MB, in one request. Bigger ones go to the blob store directly, which the chat doesn't do.
      headers["x-board-filename"] = request.headers.get("x-board-filename") ?? "file";
    } else if (route.startsWith("/attachments/uploads")) {
      return refuse(404, "the chat takes files of at most 4 MB", "not_found");
    } else {
      return refuse(404, "not something the chat does");
    }
  } else {
    return refuse(404, "not something the chat does");
  }

  const upstream = await factory.request(`${route}${url.search}`, {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
    // Not for the events long-poll, which ends on its own within 25 seconds: the board logs an aborted one as an error.
    ...(route === "/events" ? {} : { signal: request.signal }),
    as: profile,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

export const GET = handle, POST = handle;
