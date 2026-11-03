import { factory } from "@/app/api/board/[[...path]]/route";
import { open, sameOrigin } from "@/lib/gate";

// The launcher's chat reaches the board through here: the page is just another board handle, on
// `http()` to this route, as `vb inspect`'s page is on its proxy. It acts as `launcher`, for whoever
// is on the page, and only reads and posts in dev/factory (that channel alone, not a subtree).

// Events long-poll.
export const maxDuration = 300;

const profile = "launcher";
const chat = "dev/factory";

const refuse = (status: number, message: string) => Response.json({ error: { code: "forbidden", message } }, { status });

/** Whether a message's thread is in dev/factory. */
const inChannel = async (id: string) => (await factory.thread(id).catch(() => null))?.message.channel === chat;

async function handle(request: Request, { params }: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const url = new URL(request.url);
  if (await open(url.host)) return refuse(403, "the chat is off until this deployment is protected");
  const { path = [] } = await params;
  const route = `/${path.join("/")}`;
  const channel = url.searchParams.get("channel");
  let body: Uint8Array<ArrayBuffer> | undefined;

  if (request.method === "GET") {
    const free = route === "/" || route === "/me";
    const listed = (route === "/messages" || route === "/threads" || route === "/events") && channel === chat;
    const one = /^\/messages\/[A-Za-z0-9_-]+$/.test(route) && (await inChannel(path[1]!));
    if (!free && !listed && !one) return refuse(404, "not something the chat reads");
  } else if (request.method === "POST" && route === "/messages") {
    // Writes come only from this page: a form elsewhere can't post as the launcher.
    if (!sameOrigin(request)) return refuse(403, "the chat posts only from its own page");
    body = new Uint8Array(await request.arrayBuffer());
    const sent = JSON.parse(new TextDecoder().decode(body)) as { channel?: string; re?: string };
    if (sent.re ? !(await inChannel(sent.re)) : sent.channel !== chat) return refuse(403, `the chat posts only in ${chat}`);
  } else {
    return refuse(404, "not something the chat does");
  }

  const upstream = await factory.request(`${route}${url.search}`, {
    method: request.method,
    headers: { "content-type": request.headers.get("content-type") ?? "application/json", accept: request.headers.get("accept") ?? "application/json" },
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
