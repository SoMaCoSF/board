// TEMPORARY (board #1559): does the Vercel API take the deployment's raw OIDC token anywhere
// `vercel logs` needs it? The sandbox SDK already uses it against vercel.com/api with a
// teamId, and `vercel logs` reads vercel.com/api/logs/request-logs, not api.vercel.com.
// Preview only; delete before merging.

export const maxDuration = 300;

const page = (body: string) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>OIDC → Vercel API test</title>
<body style="font:14px ui-monospace,monospace;max-width:900px;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:18px">Does the Vercel API take the raw project OIDC token, the way the sandbox SDK uses it?</h1>
<p>With this deployment's OIDC token (never shown), and the team and project IDs from its claims:</p>
<ol><li>this function calls the endpoints <code>vercel logs</code> and the sandbox SDK use, on vercel.com/api and api.vercel.com, with <code>teamId</code></li>
<li>a fresh Vercel Sandbox runs <code>vercel logs</code> with a placeholder token, and its network policy swaps in the OIDC token on both hosts (~1 min)</li></ol>
<form method=post><button style="font:inherit;padding:.4rem 1rem">Run the checks</button></form>
${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const block = (title: string, text: string) =>
  `<h2 style="font-size:15px">${esc(title)}</h2><pre style="white-space:pre-wrap;background:#f4f4f4;padding:.75rem">${esc(text)}</pre>`;

const guard = () => (process.env.VERCEL_ENV === "production" ? new Response("not found", { status: 404 }) : null);

export async function GET() {
  return guard() ?? page("");
}

export async function POST() {
  const blocked = guard();
  if (blocked) return blocked;
  const [{ Sandbox }, { getVercelOidcToken }] = await Promise.all([import("@vercel/sandbox"), import("@vercel/oidc")]);
  const oidc = await getVercelOidcToken();
  const claims = JSON.parse(Buffer.from(oidc.split(".")[1]!, "base64url").toString()) as Record<string, string>;
  const team = claims.owner_id!;
  const project = claims.project_id!;
  const out = [block("OIDC claims", JSON.stringify({ ...claims, jti: undefined }, null, 2))];

  const now = Date.now();
  const logsQuery = `projectId=${project}&ownerId=${team}&page=0&startDate=${now - 3_600_000}&endDate=${now}`;
  for (const url of [
    `https://vercel.com/api/logs/request-logs?${logsQuery}`,
    `https://vercel.com/api/v9/projects/${project}?teamId=${team}`,
    `https://api.vercel.com/v9/projects/${project}?teamId=${team}`,
    `https://vercel.com/api/v6/deployments?projectId=${project}&teamId=${team}&limit=1`,
    `https://vercel.com/api/v1/sandboxes?teamId=${team}&project=${project}&limit=1`,
  ]) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${oidc}` } });
      out.push(block(`GET ${url.replace(/\?.*/, "")} → ${res.status}`, (await res.text()).slice(0, 500)));
    } catch (error) {
      out.push(block(`GET ${url} failed`, String(error)));
    }
  }

  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  try {
    sandbox = await Sandbox.create({ runtime: "node24", timeout: 10 * 60_000 });
    const setup = await sandbox.runCommand({ cmd: "bash", args: ["-c", "npm install -g vercel >/dev/null 2>&1 && vercel --version"], sudo: true });
    out.push(block(`install vercel CLI → exit ${setup.exitCode}`, (await setup.stdout()) + (await setup.stderr())));
    const swap = [{ transform: [{ headers: { authorization: `Bearer ${oidc}` } }] }];
    await sandbox.update({ networkPolicy: { allow: { "api.vercel.com": swap, "vercel.com": swap, "*": [] } } });
    for (const cmd of [`vercel logs --project ${project} --scope ${team} --since 1h --limit 5`, `vercel logs --since 1h --limit 5`]) {
      const run = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `${cmd} --no-color 2>&1`],
        env: { VERCEL_TOKEN: "fromthenetworkpolicy", VERCEL_ORG_ID: team, VERCEL_PROJECT_ID: project, VERCEL_TELEMETRY_DISABLED: "1" },
      });
      out.push(block(`sandbox: ${cmd} → exit ${run.exitCode}`, (await run.stdout()).slice(-3000)));
    }
  } catch (error) {
    out.push(block("sandbox failed", String((error as Error).stack ?? error)));
  } finally {
    await sandbox?.stop().catch(() => {});
  }
  return page(out.join("\n"));
}
