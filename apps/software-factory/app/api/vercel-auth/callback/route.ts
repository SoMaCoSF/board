import type { NextRequest } from "next/server";
import { authorize } from "../../board/[[...path]]/vercel";

const page = (status: number, text: string) =>
  new Response(`<!doctype html><meta charset=utf-8><body style="font:15px system-ui;max-width:640px;margin:3rem auto">${text}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const state = req.cookies.get("vercel_auth_state")?.value;
  const verifier = req.cookies.get("vercel_auth_verifier")?.value;
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return page(400, `Vercel said: ${url.searchParams.get("error")}`);
  if (!code || !state || !verifier || url.searchParams.get("state") !== state) {
    return page(400, "That didn't match a sign-in started here. Start again at /api/vercel-auth.");
  }
  try {
    const { getVercelOidcToken } = await import("@vercel/oidc");
    await authorize({ oidc: await getVercelOidcToken(), code, verifier, redirectUri: `${url.origin}/api/vercel-auth/callback` });
  } catch (error) {
    return page(502, `Couldn't finish: ${String((error as Error).message).replace(/[<&]/g, "")}`);
  }
  return page(200, "Done. Pi can read the factory's logs from its next message on.");
}
