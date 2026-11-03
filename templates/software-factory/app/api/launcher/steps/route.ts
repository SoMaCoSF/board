import { connectors, factory, repoChannels, slackChannels } from "@/app/api/board/[[...path]]/route";
import { open } from "@/lib/gate";
import { liveDeps, setup } from "@/lib/setup";

// The setup page's steps, checked now, for the agent's setup_steps tool: the page's own checks, so
// the agent never guesses at them.

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (await open(new URL(request.url).host)) {
    return Response.json({ error: { code: "forbidden", message: "the setup checks are off until this deployment is protected" } }, { status: 403 });
  }
  const deps = await liveDeps(async (query) => (await factory.messages(query)).messages, { connectors, repoChannels, slackChannels });
  const steps = await setup(deps);
  return Response.json(steps.map(({ title, status, optional, summary, rows, fix }) => ({ title, status, optional, summary, rows, fix })));
}
