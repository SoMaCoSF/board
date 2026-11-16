import { team } from "@/lib/board";
import { history } from "@/lib/campaign";
import { open } from "@/lib/gate";

// A file an agent attached to a task's thread: a patch, mostly. The browser asks this deployment,
// which reads it from the board, and only a file that's on a message of that campaign's task.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (await open(request.headers.get("host"))) return new Response("this deployment is open to anyone", { status: 403 });
  const query = new URL(request.url).searchParams;
  const [slug, task, id] = [query.get("c") ?? "", query.get("task") ?? "", query.get("id") ?? ""];
  if (!/^c[a-z0-9]{4,16}$/.test(slug) || !/^[\w.:#-]{1,128}$/.test(task)) return new Response("not a task", { status: 400 });
  const thread = await history(slug, task).catch(() => null);
  const file = thread?.replies.flatMap((reply) => reply.files).find((entry) => entry.id === id);
  if (!file) return new Response("no such file", { status: 404 });
  const found = await team().download(id);
  return new Response(found.body, {
    status: found.status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${file.name.replace(/[^\w.-]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  });
}
