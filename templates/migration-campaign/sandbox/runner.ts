// Runs in a worker's sandbox, one agent to a sandbox. The loop is code, not a model's judgment:
// claim the oldest ready task, give a fresh agent that one task, check its change with the
// campaign's verify command, have a second model read the diff, deliver it, and settle the task.
// A model only ever decides what to change in a file.
//
// A task's state is its thread's labels, and every step here is a compare-and-set on them
// (`vb label --if`), the same steps lib/queue.ts takes from the app: a claim lands only on a ready
// task, and everything after it lands only while the claim's token is still this agent's.
//
// The board is reached through `vb`, with nothing to authenticate with: the sandbox's network
// policy adds the credential and this agent's profile on the way out, and the same for AI Gateway
// and GitHub.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { blocked, costOf, LABEL, LEASE_MS, note, SANDBOX, taskFiles, verdict, type RunnerConfig } from "./shared.ts";

const config = JSON.parse(await readFile(process.env.RUNNER_CONFIG ?? SANDBOX.config, "utf8")) as RunnerConfig;
const HOME = join(SANDBOX.dir, "home");
const VB = join(SANDBOX.dir, "node_modules", ".bin", "vb");
const exec = promisify(execFile);

/** A claim is renewed this often: several times within its lease, so one failed renewal doesn't lose the task. */
const RENEW_MS = 2 * 60_000;
/** A verify command that runs longer than this has hung. */
const VERIFY_MS = 10 * 60_000;
/** One agent turn: long enough for a real change, short enough that a stuck one ends. */
const TURN_MS = 12 * 60_000;
/** How much of a diff a reviewer reads, and of a failed verify an agent reads. */
const DIFF_MAX = 60_000;
const OUTPUT_MAX = 3_000;

const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ worker: config.worker, at: new Date().toISOString(), ...event })}\n`);
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ─── the board, through vb ──────────────────────────────────────────────────

type Failure = Error & { reason?: string };

/** One `vb` command, answering its JSON document. A failure carries the `reason` vb gave, to branch on. */
async function vb<T = unknown>(...args: string[]): Promise<T> {
  try {
    const { stdout } = await exec(VB, [...args, "--json"], { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 });
    return (stdout.trim() ? JSON.parse(stdout) : {}) as T;
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    const said = `${stderr}\n${stdout}`;
    const failure: Failure = new Error(`vb ${args.slice(0, 3).join(" ")}: ${tail(said.trim() || message(error), 600)}`);
    failure.reason = /"reason"\s*:\s*"([\w-]+)"/.exec(said)?.[1] ?? /"code"\s*:\s*"([\w-]+)"/.exec(said)?.[1];
    throw failure;
  }
}

type Message = { id: string; text: string; labels: Record<string, string>; by?: { actor?: string }; author?: { handle?: string; kind?: string } };

const reply = (id: string, text: string, attach: string[] = []) => vb(...["reply", id, text.slice(0, 9_000), ...attach.flatMap((file) => ["--attach", file])]).catch((error) => log({ type: "error", message: message(error) }));

/** The campaign's phase, from its thread's root. Agents work only while it says `running`. */
const phase = async () => (await vb<{ message: Message }>("read", config.campaign)).message.labels.phase;

// ─── git ────────────────────────────────────────────────────────────────────

const git = async (...args: string[]) => (await exec("git", args, { cwd: config.repo, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

/** The checkout as every task finds it: at the campaign's base commit, with nothing left over from the last task. */
async function clean() {
  await git("rebase", "--abort").catch(() => {});
  await git("checkout", "-q", "--detach", config.base);
  await git("reset", "-q", "--hard", config.base);
  await git("clean", "-qfd");
}

// ─── agents ─────────────────────────────────────────────────────────────────

const piDir = join(HOME, ".pi");
await mkdir(piDir, { recursive: true });
// pi's catalog can trail the gateway: declaring the campaign's models on its gateway provider makes any ID work.
await writeFile(
  join(piDir, "models.json"),
  JSON.stringify({
    providers: {
      "vercel-ai-gateway": {
        models: Object.entries(config.models).map(([id, { context }]) => ({
          id,
          name: id,
          api: "anthropic-messages",
          baseUrl: "https://ai-gateway.vercel.sh",
          reasoning: true,
          input: ["text"],
          contextWindow: context,
          maxTokens: 16_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  }),
);
const modelRuntime = await ModelRuntime.create({ authPath: join(piDir, "auth.json"), modelsPath: join(piDir, "models.json") });

/** What a task has spent so far, by model. */
type Spend = { tokens: number; cost: number };

/**
 * A fresh agent on the checkout: it knows nothing but its prompt, and reads no instructions from
 * the repository's own agent files, which a migration's target shouldn't steer. `write` says
 * whether it may change files.
 */
async function agent(modelId: string, system: string, write: boolean, spend: Spend) {
  const model = modelRuntime.getModel("vercel-ai-gateway", modelId);
  if (!model) throw new Error(`AI Gateway has no model ${modelId}`);
  const cwd = config.repo;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: piDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [system],
  });
  await resourceLoader.reload();
  const readers = [createReadToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd)];
  const writers = [createBashToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd)];
  const tools = (write ? [...readers, ...writers] : readers) as ToolDefinition<any, any, any>[];
  const { session } = await createAgentSession({
    cwd,
    agentDir: piDir,
    model,
    thinkingLevel: config.thinking,
    modelRuntime,
    resourceLoader,
    tools: tools.map((tool) => tool.name),
    customTools: tools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 4 }, compaction: { enabled: true } }),
  });
  let failed: string | null = null;
  session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const { usage } = event.message;
    spend.tokens += usage.input + usage.output + usage.cacheRead;
    spend.cost += costOf(usage, config.models[modelId]?.price ?? null);
    if (event.message.stopReason === "error" && event.message.errorMessage && !/aborted/i.test(event.message.errorMessage)) failed = event.message.errorMessage;
  });
  return {
    /** One turn: the agent's last words. Throws when the model failed, or the turn ran out of time. */
    async ask(prompt: string, stop: AbortSignal): Promise<string> {
      failed = null;
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, TURN_MS);
      const abort = () => void session.abort();
      stop.addEventListener("abort", abort);
      try {
        await session.prompt(prompt);
      } finally {
        clearTimeout(watchdog);
        stop.removeEventListener("abort", abort);
      }
      if (stop.aborted) throw new Error("the claim on this task was lost");
      if (timedOut) throw new Error(`the agent's turn ran past ${TURN_MS / 60_000} minutes`);
      if (failed) throw new Error(`the model failed: ${failed}`);
      const messages = session.messages as Array<{ role: string; content?: unknown }>;
      const last = [...messages].reverse().find((entry) => entry.role === "assistant");
      const parts = Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : [];
      return parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    },
  };
}

const WORKER = (files: string[], notes: string) => `You are one of several agents migrating a codebase. The repository is checked out in the current directory, and you work on one task of the migration.

## The migration

${config.instructions}

## Your task

Make the migration's change in these files, and only these:
${files.map((file) => `- ${file}`).join("\n")}
${notes ? `\n## What people said in this task's thread\n\n${notes}\n` : ""}
## Rules

- Change another file only when the task's files can't be migrated without it, and say which and why.
- Don't commit, push, switch branches, or install dependencies: the harness does what's needed after you.
- A file that needs no change is left as it is.
- When you're done, answer with one or two plain sentences on what you changed.
- If the task can't be done as the migration says, change nothing and answer with a first line \`BLOCKED: <why>\`: a person reads it.
${config.verify ? `\nAfter you finish, the harness runs this, and it must exit 0:\n\n    ${command(files)}\n` : ""}`;

const REVIEWER = `You review one change of a codebase migration. You're given the migration's instructions and the diff of one task. You may read the repository, which has the change applied, and you can't change it.

Approve a diff that does what the migration says in the task's files and nothing else. Ask for changes when it does less, does something the migration doesn't ask for, or would break the code. Style you'd have chosen differently isn't a reason.

Answer with a first line that is exactly APPROVE or CHANGES. After CHANGES, say what to fix, briefly, one item per line.`;

/** The campaign's verify command for a task's files. */
function command(files: string[]) {
  return config.verify.replaceAll("{files}", files.join(" "));
}

/** Runs the verify command. Null when it passed, or the end of what it printed. */
async function verify(files: string[]): Promise<string | null> {
  if (!config.verify) return null;
  try {
    await exec("bash", ["-lc", command(files)], { cwd: config.repo, timeout: VERIFY_MS, maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (error) {
    const { stdout = "", stderr = "", killed } = error as { stdout?: string; stderr?: string; killed?: boolean };
    return tail(`${killed ? `(stopped after ${VERIFY_MS / 60_000} minutes)\n` : ""}${stdout}\n${stderr}`.trim() || message(error), OUTPUT_MAX);
  }
}

// ─── delivery ───────────────────────────────────────────────────────────────

/** A pull request for a pushed branch, through GitHub's API: the network policy adds the token. Its URL, or the one already open for the branch. */
async function pullRequest(branch: string, title: string, body: string): Promise<string> {
  const api = `https://api.github.com/repos/${config.github}/pulls`;
  const headers = { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "migration-campaign" };
  const made = await fetch(api, { method: "POST", headers, body: JSON.stringify({ title, body, head: branch, base: config.baseBranch }) });
  if (made.ok) return ((await made.json()) as { html_url: string }).html_url;
  const open = await fetch(`${api}?head=${config.github!.split("/")[0]}:${encodeURIComponent(branch)}&state=open`, { headers });
  const [existing] = open.ok ? ((await open.json()) as Array<{ html_url: string }>) : [];
  if (existing) return existing.html_url;
  throw new Error(`GitHub refused the pull request (${made.status}): ${tail(await made.text(), 300)}`);
}

/** Commits the task's change and hands it over as the campaign delivers. What a person reads about where it went, and the files to attach. */
async function deliver(task: Message, title: string, summary: string): Promise<{ line: string; attach: string[] }> {
  await git("add", "-A");
  await git("-c", `user.name=${config.worker}`, "-c", `user.email=${config.worker}@users.noreply.github.com`, "commit", "-q", "-m", `${config.title}: ${title}`, "-m", summary.slice(0, 2_000));
  if (config.delivery === "patch") {
    const file = join(HOME, `${config.slug}-${task.id.replace(/\W+/g, "")}.patch`);
    await writeFile(file, `${await git("format-patch", "-1", "--stdout")}\n`);
    return { line: "The patch is attached.", attach: [file] };
  }
  if (config.delivery === "prs") {
    const branch = `${config.campaignBranch}/${task.id.replace(/\W+/g, "")}`;
    await git("push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
    const url = await pullRequest(branch, `${config.title}: ${title}`, `${summary}\n\nOne task of the migration campaign \`${config.slug}\`.`);
    return { line: url, attach: [] };
  }
  // One branch for the whole campaign: tasks touch different files, so a rebase onto what the others pushed is clean, and a push that lost a race tries again.
  for (let attempt = 1; ; attempt++) {
    await git("fetch", "-q", "origin", config.campaignBranch);
    await git("rebase", "-q", "FETCH_HEAD");
    try {
      await git("push", "-q", "origin", `HEAD:refs/heads/${config.campaignBranch}`);
      return { line: `Pushed ${(await git("rev-parse", "--short", "HEAD")).trim()} to \`${config.campaignBranch}\`.`, attach: [] };
    } catch (error) {
      if (attempt >= 5) throw error;
    }
  }
}

// ─── one task ───────────────────────────────────────────────────────────────

/** What people wrote in a task's thread: a held task's answer is there. The agents' own replies are left out. */
async function notes(id: string): Promise<string> {
  const { replies } = await vb<{ replies: Message[] }>("read", id);
  return replies
    .filter((entry) => !/\+worker-\d+$/.test(entry.by?.actor ?? "") && entry.author?.kind !== "profile")
    .slice(-5)
    .map((entry) => `${entry.author?.handle ?? "someone"}: ${entry.text.slice(0, 1_500)}`)
    .join("\n\n");
}

type Outcome = { state: "completed"; result: string } | { state: "blocked"; reason: string; kind: string };

async function work(task: Message, stop: AbortSignal, spend: Spend): Promise<Outcome> {
  const files = taskFiles(task.text);
  const title = task.text.split("\n", 1)[0]!;
  if (files.length === 0) return { state: "blocked", reason: "This task names no files.", kind: "needs_input" };
  await clean();
  const worker = await agent(config.model, WORKER(files, await notes(task.id)), true, spend);
  let summary = await worker.ask("Start now.", stop);

  for (let round = 0; ; round++) {
    const why = blocked(summary);
    if (why) return { state: "blocked", reason: why, kind: "needs_input" };
    // Staged, so new files count, and listed by name: what the change touched since the campaign's base.
    await git("add", "-A");
    const changed = (await git("diff", "--cached", "--name-only", config.base)).split("\n").filter(Boolean);
    if (changed.length === 0) return { state: "completed", result: `No change needed. ${summary}`.slice(0, 900) };

    // What sends the agent back: a failed verify first, since a reviewer shouldn't read a change that doesn't run.
    let back: string | null = null;
    const failure = await verify(files);
    if (failure) {
      await reply(task.id, `Verify failed (round ${round + 1}):\n\n\`\`\`\n${failure}\n\`\`\``);
      back = `The verify command failed. Fix the change so it passes.\n\n${failure}`;
    } else if (config.reviewModel) {
      const diff = await git("diff", "--cached", config.base);
      const reviewer = await agent(config.reviewModel, REVIEWER, false, spend);
      const answer = verdict(await reviewer.ask(`## The migration\n\n${config.instructions}\n\n## The task's files\n\n${files.join("\n")}\n\n## The diff\n\n\`\`\`diff\n${tail(diff, DIFF_MAX)}\n\`\`\``, stop));
      if (!answer.approved) {
        await reply(task.id, `Review asked for changes (round ${round + 1}):\n\n${answer.notes.slice(0, 2_000)}`);
        back = `A reviewer read your diff and asked for changes. Make them.\n\n${answer.notes}`;
      }
    }

    if (!back) {
      const outside = changed.filter((file) => !files.includes(file));
      const delivered = await deliver(task, title, summary);
      const also = outside.length ? `\n\nAlso changed, outside the task's files: ${outside.join(", ")}` : "";
      await reply(task.id, `${summary}\n\n${delivered.line}${also}`, delivered.attach);
      return { state: "completed", result: `${delivered.line} ${summary}`.slice(0, 900) };
    }
    if (round >= config.rounds) return { state: "blocked", reason: `Still not right after ${round + 1} ${round ? "tries" : "try"}. The thread has what failed.`, kind: "needs_input" };
    summary = await worker.ask(back, stop);
  }
}

// ─── the queue ──────────────────────────────────────────────────────────────

type Held = { task: Message; token: string };

const lease = () => new Date(Date.now() + LEASE_MS).toISOString();
const conflict = (error: unknown) => (error as Failure).reason === "label_conflict";

/** Claims a task: a ready one, or with `stalled`, one whose claim ran out and is still that claim. Null: another agent was first. */
async function claim(task: Message, stalled?: string): Promise<Held | null> {
  const token = randomUUID();
  try {
    await vb(
      "label",
      task.id,
      `${LABEL.state}=claimed`,
      `${LABEL.owner}=${config.worker}`,
      `${LABEL.claim}=${token}`,
      `${LABEL.lease}=${lease()}`,
      "--unset",
      LABEL.note,
      "--unset",
      LABEL.kind,
      "--if",
      stalled ? `${LABEL.claim}=${stalled}` : `${LABEL.state}=ready`,
    );
    return { task, token };
  } catch (error) {
    if (conflict(error)) return null;
    throw error;
  }
}

const listed = async (state: string, limit: number) => (await vb<{ threads: { message: Message }[] }>("read", config.channel, "--label", `${LABEL.state}=${state}`, "--limit", String(limit))).threads;

/** The oldest task this agent can take: a ready one first, then one another agent stalled on. Null when there's none right now. */
async function claimNext(): Promise<Held | null> {
  for (const { message } of await listed("ready", 20)) {
    const held = await claim(message);
    if (held) return held;
  }
  const now = new Date().toISOString();
  for (const { message } of await listed("claimed", 50)) {
    const [until, token] = [message.labels[LABEL.lease], message.labels[LABEL.claim]];
    if (!until || !token || until > now) continue;
    const held = await claim(message, token);
    if (held) return held;
  }
  return null;
}

/** Ends this agent's claim with the task's new state, and what the task cost. False: the claim was lost, and the state stays as someone else left it. */
async function settle(held: Held, outcome: Outcome, spend: Spend): Promise<boolean> {
  const spent = [`${LABEL.cost}=${spend.cost.toFixed(4)}`, `${LABEL.tokens}=${spend.tokens}`];
  const end =
    outcome.state === "completed"
      ? [`${LABEL.state}=completed`, `${LABEL.note}=${note(outcome.result)}`, "--unset", LABEL.kind]
      : [`${LABEL.state}=blocked`, `${LABEL.note}=${note(outcome.reason)}`, `${LABEL.kind}=${outcome.kind}`];
  try {
    await vb("label", held.task.id, ...end, ...spent, "--unset", LABEL.claim, "--unset", LABEL.lease, "--if", `${LABEL.claim}=${held.token}`);
    return true;
  } catch (error) {
    if (!conflict(error)) throw error;
    // The task is someone else's now, but the money was spent: it still counts toward the campaign's budget.
    await vb("label", held.task.id, ...spent).catch(() => {});
    return false;
  }
}

// ─── the loop ───────────────────────────────────────────────────────────────

await writeFile(SANDBOX.pid, String(process.pid));
log({ type: "up", model: config.model, review: config.reviewModel });
let errors = 0;
let idle = 0;
while (Date.now() < config.deadline) {
  if ((await phase().catch(() => "running")) !== "running") break;
  let held: Held | null = null;
  try {
    held = await claimNext();
  } catch (error) {
    log({ type: "error", message: message(error) });
    if (++errors >= 5) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    continue;
  }
  if (!held) {
    // Nothing to claim for a few minutes: the queue is done, or what's left waits for a person. The app starts agents again when there's work.
    if (++idle >= 4) break;
    await vb("wait", config.channel, "--label", `${LABEL.state}=ready`, "--timeout", "45s").catch(() => {});
    continue;
  }
  idle = 0;
  const { task, token } = held;
  log({ type: "claimed", task: task.id, title: task.text.split("\n", 1)[0] });

  // The claim is renewed while the agent works. Once it's lost, someone else holds the task: stop, and settle nothing.
  const lost = new AbortController();
  const renewing = setInterval(() => {
    vb("label", task.id, `${LABEL.lease}=${lease()}`, "--if", `${LABEL.claim}=${token}`).catch((error: unknown) => {
      if (conflict(error)) lost.abort();
    });
  }, RENEW_MS);
  const spend: Spend = { tokens: 0, cost: 0 };
  let outcome: Outcome;
  try {
    outcome = await work(task, lost.signal, spend);
    errors = 0;
  } catch (error) {
    outcome = { state: "blocked", reason: message(error).slice(0, 800), kind: "error" };
    errors++;
  } finally {
    clearInterval(renewing);
  }
  try {
    if (outcome.state === "blocked") await reply(task.id, `Held for a person: ${outcome.reason}`);
    const settled = await settle(held, outcome, spend);
    log({ type: settled ? outcome.state : "lost", task: task.id, cost: spend.cost });
  } catch (error) {
    log({ type: "error", message: message(error) });
  }
  // A model or a sandbox that keeps failing would hold every task it touches: this agent stops instead.
  if (errors >= 3) break;
}
await clean().catch(() => {});
log({ type: "down" });
process.exit(0);
