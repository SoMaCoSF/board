// TEMPORARY (board #1559): checks that the factory's Vercel App signs in with the deployment's
// OIDC token and that its token reads logs, the way PR #89 hands it to Pi. Preview only; delete before merging.
import { vercelToken } from "../board/[[...path]]/vercel";

export const maxDuration = 300;

const PROJECT = "vboard-factory";
const TEAM = "vercel-internal-playground";

const page = (body: string) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>OIDC → Vercel API test</title>
<body style="font:14px ui-monospace,monospace;max-width:900px;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:18px">Can the Vercel App's token (from OIDC) read the factory's logs?</h1>
<p>Gets the Vercel App's token the way Pi does (authorize it first at <a href=/api/vercel-auth>/api/vercel-auth</a>; no token is shown), then:</p>
<ol><li>this function calls <code>api.vercel.com</code> directly with it</li>
<li>a fresh Vercel Sandbox runs <code>vercel logs</code> with a placeholder token, and its network policy swaps in the app's, exactly as PR #89 does for Pi (~1 min)</li></ol>
<form method=post><button style="font:inherit;padding:.4rem 1rem">Run the checks</button></form>
${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const block = (title: string, text: string) => `<h2 style="font-size:15px">${esc(title)}</h2><pre style="white-space:pre-wrap;background:#f4f4f4;padding:.75rem">${esc(text)}</pre>`;

const guard = () => (process.env.VERCEL_ENV === "production" ? new Response("not found", { status: 404 }) : null);

export async function GET() {
  return guard() ?? page("");
}

export async function POST() {
  const blocked = guard();
  if (blocked) return blocked;
  const [{ Sandbox }, { getVercelOidcToken }] = await Promise.all([import("@vercel/sandbox"), import("@vercel/oidc")]);
  const out: string[] = [];
  let token: string;
  try {
    const minted = await vercelToken({ oidc: await getVercelOidcToken() });
    if (!minted) return page(block("app token: none yet", "Nobody has authorized the app on this deployment. Open /api/vercel-auth first, then run the checks again."));
    token = minted;
    const claims = token.split(".").length === 3 ? JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) : null;
    out.push(block("app token: minted ✓", claims ? JSON.stringify({ ...claims, jti: undefined }, null, 2) : `opaque, ${token.length} chars`));
  } catch (error) {
    return page(block("app token: failed ✗", String((error as Error).message)));
  }

  // 1. Straight from the function.
  for (const path of [`/v9/projects/${PROJECT}?slug=${TEAM}`, `/v6/deployments?projectId=${PROJECT}&slug=${TEAM}&limit=1`]) {
    try {
      const res = await fetch(`https://api.vercel.com${path}`, { headers: { authorization: `Bearer ${token}` } });
      out.push(block(`GET ${path} → ${res.status}`, (await res.text()).slice(0, 600)));
    } catch (error) {
      out.push(block(`GET ${path} failed`, String(error)));
    }
  }

  // 2. The CLI in a sandbox, through the network policy.
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  try {
    sandbox = await Sandbox.create({ runtime: "node24", timeout: 10 * 60_000 });
    const setup = await sandbox.runCommand({ cmd: "bash", args: ["-c", "npm install -g vercel >/dev/null 2>&1 && vercel --version"], sudo: true });
    out.push(block(`install vercel CLI → exit ${setup.exitCode}`, (await setup.stdout()) + (await setup.stderr())));
    await sandbox.update({
      networkPolicy: {
        allow: {
          "api.vercel.com": [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }],
          "*": [],
        },
      },
    });
    for (const cmd of [
      `vercel whoami`,
      `vercel logs --project ${PROJECT} --scope ${TEAM} --since 1h --limit 5`,
    ]) {
      const run = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `${cmd} --token fromthenetworkpolicy --no-color 2>&1`],
        env: { VERCEL_TOKEN: "fromthenetworkpolicy", VERCEL_TELEMETRY_DISABLED: "1" },
      });
      out.push(block(`sandbox: ${cmd} → exit ${run.exitCode}`, (await run.stdout()).slice(-4000)));
    }
  } catch (error) {
    out.push(block("sandbox failed", String((error as Error).stack ?? error)));
  } finally {
    await sandbox?.stop().catch(() => {});
  }
  return page(out.join("\n"));
}
