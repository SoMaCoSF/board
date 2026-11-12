import { agentBoard } from "@/agent/lib/vb-tool";
import { WATCHER } from "@/agent/lib/identity";
import { sendToAgent } from "@/agent/lib/wake";
import { factory } from "@/app/api/board/[[...path]]/factory";
import { ownRequest, startFirstTask } from "@/lib/first-task";
import { check } from "@/lib/launcher";
import { channel } from "@/lib/project";

// Starts the factory's first task: the one thing the launcher writes, and only when asked. The
// page's Start button posts here, and so can an agent setting the factory up.

export const dynamic = "force-dynamic";
// The wake-up is tried 3 times, 30 seconds each at most, and says so in the thread when it never gets there.
export const maxDuration = 300;

const refuse = (message: string) => Response.json({ error: { code: "forbidden", message } }, { status: 403 });

export async function POST(request: Request): Promise<Response> {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!ownRequest(request.headers.get("origin"), host)) return refuse("only this deployment's own page starts its first task");
  const { result } = await check(host);
  // As on the page: nothing about the factory, and nothing from it, while anyone can ask.
  if (result.open) return refuse("the first task is off until this deployment is protected");
  // Not on offer: it started already, or the README is the team's own, or the factory can't write to its repo yet.
  if (result.found.first !== "offer") return Response.json({ started: false, first: result.found.first });
  // A wake-up that never gets there is said in the thread, as the watcher says it.
  const root = await startFirstTask(agentBoard(factory), channel("rsi"), (message) => sendToAgent(factory.as(WATCHER), message));
  return Response.json({ started: true, thread: root.id });
}
