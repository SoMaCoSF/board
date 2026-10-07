// TEMPORARY (board #1559): runs `vercel logs` with FACTORY_VERCEL_TOKEN in a fresh sandbox, through the
// same network-policy swap and env Pi gets from #89. Preview only; delete before merging.
import { policy } from "../board/[[...path]]/agent";

export const maxDuration = 300;

const ORG = "team_TtmJZYmD3tcLBLqWOhoVawd1";
const PROJECT = "prj_Cu5qMQq8MGIQUIyWGOqgZgJPBG4z";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const block = (title: string, text: string) =>
  `<h2 style="font-size:15px">${esc(title)}</h2><pre style="white-space:pre-wrap;background:#f4f4f4;padding:.75rem">${esc(text)}</pre>`;
const page = (body: string) =>
  new Response(
    `<!doctype html><meta charset=utf-8><title>vercel logs test</title>
<body style="font:14px ui-monospace,monospace;max-width:900px;margin:2rem auto;padding:0 1rem">
<h1 style="font-size:18px">Does FACTORY_VERCEL_TOKEN let Pi run vercel logs?</h1>
<p>A fresh sandbox gets #89's network policy (the token is swapped in on the wire, never shown) and Pi's env, then runs the commands below (~1 min).</p>
<form method=post><button style="font:inherit;padding:.4rem 1rem">Run</button></form>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
const guard = () => (process.env.VERCEL_ENV === "production" ? new Response("not found", { status: 404 }) : null);

export async function GET() {
  return guard() ?? page("");
}

export async function POST() {
  const blocked = guard();
  if (blocked) return blocked;
  const vercel = process.env.FACTORY_VERCEL_TOKEN;
  if (!vercel) return page(block("FACTORY_VERCEL_TOKEN", "not set on this deployment"));
  const { Sandbox } = await import("@vercel/sandbox");
  const out: string[] = [];
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  try {
    sandbox = await Sandbox.create({ runtime: "node24", timeout: 10 * 60_000 });
    const setup = await sandbox.runCommand({ cmd: "bash", args: ["-c", "npm install -g vercel >/dev/null 2>&1 && vercel --version"], sudo: true });
    out.push(block(`install vercel → exit ${setup.exitCode}`, (await setup.stdout()) + (await setup.stderr())));
    // #89's policy, with dummies for the credentials this test doesn't use.
    await sandbox.update({ networkPolicy: policy(0, { vercelOidc: "unused", board: "unused", github: "unused", vercel }) });
    const probe = `
A=https://api.vercel.com; Q="teamId=${ORG}"
show() { echo "== $1"; curl -s --max-time 10 -w '\\nHTTP %{http_code}' "$2" | tail -c 600; echo; }
DPL=$(curl -s "$A/v6/deployments?projectId=${PROJECT}&$Q&limit=1&target=production" | sed -n 's/.*"uid":"\\(dpl_[^"]*\\)".*/\\1/p' | head -1)
echo "deployment: $DPL"
echo "== runtime-logs (streams for 25s; headers first, then whatever lines arrive)"
[ -n "$DPL" ] && curl -sN --max-time 25 -D - "$A/v1/projects/${PROJECT}/deployments/$DPL/runtime-logs?format=lines&$Q" | head -c 2500; echo
NOW=$(( $(date +%s) * 1000 )); FROM=$(( NOW - 3600000 ))
show "request-logs" "https://vercel.com/api/logs/request-logs?projectId=${PROJECT}&ownerId=${ORG}&$Q&page=0&startDate=$FROM&endDate=$NOW"
`;
    for (const cmd of [
      probe,
    ]) {
      const run = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `${cmd} 2>&1`],
        env: { VERCEL_TOKEN: "fromthenetworkpolicy", VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: PROJECT, VERCEL_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
      });
      out.push(block(`$ ${cmd === probe ? "API probes" : cmd} → exit ${run.exitCode}`, (await run.stdout()).slice(-3000)));
    }
  } catch (error) {
    out.push(block("sandbox failed", String((error as Error).stack ?? error)));
  } finally {
    await sandbox?.stop().catch(() => {});
  }
  return page(out.join("\n"));
}
