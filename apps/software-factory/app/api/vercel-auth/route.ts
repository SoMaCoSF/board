// Authorizes the factory's Vercel App once, so Pi can read the factory's logs (see vercel.ts).
// Grant only read-only permissions on the consent page.
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { AUTHORIZE_URL, VERCEL_APP } from "../board/[[...path]]/vercel";

const cookie = { maxAge: 10 * 60, secure: true, httpOnly: true, sameSite: "lax" as const, path: "/api/vercel-auth" };

export async function GET(req: NextRequest) {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(43).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: VERCEL_APP,
    redirect_uri: `${req.nextUrl.origin}/api/vercel-auth/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_type: "code",
    scope: "openid offline_access",
  });
  const res = NextResponse.redirect(`${AUTHORIZE_URL}?${params}`);
  res.cookies.set("vercel_auth_state", state, cookie);
  res.cookies.set("vercel_auth_verifier", verifier, cookie);
  return res;
}
