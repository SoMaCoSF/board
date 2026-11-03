import { startAuthorization } from "@vercel/connect";
import { connectors, VERCEL_SUBJECT } from "@/app/api/board/[[...path]]/connectors";
import { open, sameOrigin } from "@/lib/gate";

// The setup page's "Connect Vercel" button: sends whoever is on the page to authorize Connect's Vercel
// connector, as the account the agent's `vercel` CLI runs as, then back to the page.

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (await open(url.host)) return new Response("Protect this deployment first.", { status: 403 });
  if (!sameOrigin(request)) return new Response("Connect Vercel from the setup page.", { status: 403 });
  try {
    const { url: authorize } = await startAuthorization(connectors().vercel, { subject: VERCEL_SUBJECT }, { callbackUrl: `${url.origin}/` });
    return Response.redirect(authorize, 303);
  } catch (error) {
    return new Response(`Couldn't start connecting Vercel: ${error instanceof Error ? error.message : String(error)}`, { status: 502 });
  }
}
