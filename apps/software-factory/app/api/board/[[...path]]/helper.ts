import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";
import type { Experimental_SandboxSession } from "ai";
import { pi } from "experimental-a2/ai/pi";
import { agent } from "vboard/agents";
import { extension, GH, GITHUB_TOKEN, SANDBOX_MS, SNAPSHOT_MS } from "./agent.ts";

// Helper answers questions about vboard from its code, in the thread it's asked in:
// `@vboard-factory +helper what does vb wait do?` in Slack, or in a GitHub comment.
// The board runs it on A2 with Pi's loop. Pi's tools work in a sandbox of Helper's own,
// which can read the repo and GitHub and nothing else; its `vb` runs here, in the function,
// so no board credential is ever in the sandbox.

const REPO = "basehub-ai/vboard";

const INSTRUCTIONS = `You answer questions about vboard (github.com/${REPO}, private), a message board library and CLI, from its code.
Your clone of it is at ~/vboard, on main: read it with your tools (rg, git log, git show). Run git -C ~/vboard pull first when the question is about something recent.
For GitHub (issues, pull requests, their comments), use gh api with REST paths, like gh api repos/${REPO}/pulls/12/comments. Your GitHub access is read-only, and GraphQL is blocked, so gh pr view and gh issue view don't work.
Answer in the thread with vb reply <thread> "<answer>". Lead with the answer, keep it to a few lines, and point at the code as path:line when it helps. Don't recap the question.
You can't change code, push, or open pull requests. When someone wants a change, say what you'd change and where.`;

/** Root's setup, before the network policy: gh, pinned like Pi's. */
const SETUP = `set -e
command -v gh >/dev/null || {
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH}/gh_${GH}_linux_amd64.tar.gz" | tar xz -C /tmp
  install "/tmp/gh_${GH}_linux_amd64/bin/gh" /usr/local/bin/gh
}`;

/** The clone, through the policy: it's private, and only the policy has the credential. */
const CLONE = `set -e
[ -d ~/vboard/.git ] || git clone -q https://github.com/${REPO}.git ~/vboard`;

/** What GitHub's proxy answers for anything Helper may not do there. */
const READ_ONLY = {
  response: { statusCode: 403, contentType: "text/plain", body: "Helper's GitHub access is read-only.\n" },
} as const;

/**
 * The real credential on the way out, for reading only: git fetches of the repo (its upload-pack, never
 * receive-pack, which a push uses), and GETs on the REST API. GraphQL is refused, since a query and a
 * mutation look the same on the wire. Besides GitHub, only npm's registry, for pnpm install.
 */
export function helperPolicy(github: string): NetworkPolicy {
  const basic = Buffer.from(`x-access-token:${github}`).toString("base64");
  const git = { transform: [{ headers: { authorization: `Basic ${basic}` } }] };
  const repo = `^/${REPO}(\\.git)?`;
  return {
    allow: {
      "github.com": [
        {
          match: {
            method: ["GET"],
            path: { regex: `${repo}/info/refs$` },
            queryString: [{ key: { exact: "service" }, value: { exact: "git-upload-pack" } }],
          },
          ...git,
        },
        { match: { method: ["POST"], path: { regex: `${repo}/git-upload-pack$` } }, ...git },
        READ_ONLY,
      ],
      "api.github.com": [
        { match: { method: ["GET", "HEAD"] }, transform: [{ headers: { authorization: `Bearer ${github}` } }] },
        READ_ONLY,
      ],
      "registry.npmjs.org": [],
    },
  };
}

/** A session's sandbox: one per A2 session (a thread, by default), kept between turns like Pi's. */
export const helperSandbox = (session: string) =>
  ({
    name: `helper-${session}`,
    runtime: "node24",
    timeout: SANDBOX_MS,
    persistent: true,
    snapshotExpiration: SNAPSHOT_MS,
    env: { GH_TOKEN: "from-the-network-policy", GIT_TERMINAL_PROMPT: "0" },
  }) as const;

async function run(sandbox: Sandbox, script: string, sudo: boolean) {
  const done = await sandbox.runCommand({ cmd: "bash", args: ["-c", script], sudo });
  if (done.exitCode !== 0) throw new Error(`Helper's sandbox setup failed: ${(await done.stderr()).slice(-500)}`);
}

async function open(session: string): Promise<Experimental_SandboxSession> {
  const [{ Sandbox }, { getToken }, { createVercelSandboxSessionFromNativeSandbox }] = await Promise.all([
    import("@vercel/sandbox"),
    import("@vercel/connect"),
    import("@ai-sdk/sandbox-vercel"),
  ]);
  const settings = helperSandbox(session);
  let sandbox = await Sandbox.getOrCreate(settings);
  // Stopped with nothing to resume (its snapshot expired): the session starts over in a new one.
  if (sandbox.status === "stopped" && !sandbox.currentSnapshotId) {
    await sandbox.delete();
    sandbox = await Sandbox.create(settings);
  }
  await run(sandbox, SETUP, true);
  await sandbox.update({ networkPolicy: helperPolicy(await getToken("github/vboard-factory", GITHUB_TOKEN)) });
  const extend = extension(sandbox.expiresAt, Date.now());
  if (extend > 0) await sandbox.extendTimeout(extend);
  await run(sandbox, CLONE, false);
  return createVercelSandboxSessionFromNativeSandbox(sandbox);
}

/**
 * Pi's sandbox resolver, called for each step and tool call: the same sandbox every time, opened again
 * every few minutes, so its GitHub token and its session's deadline stay fresh.
 */
const FRESH_MS = 10 * 60_000;
const opened = new Map<string, { at: number; session: Promise<Experimental_SandboxSession> }>();
function sandbox({ session }: { session: { id: string } }) {
  const cached = opened.get(session.id);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.session;
  const next = open(session.id);
  next.catch(() => opened.delete(session.id));
  opened.set(session.id, { at: Date.now(), session: next });
  return next;
}

export const helper = agent({
  name: "Helper",
  model: "anthropic/claude-opus-5.5",
  instructions: INSTRUCTIONS,
  harness: pi({ sandbox }),
});
