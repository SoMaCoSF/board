import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";

// Pi, the coding agent, working on a board thread from its own Vercel Sandbox: the
// `pi` CLI with `vb`, `gh`, and git, like a developer at a terminal. Each thread gets
// one sandbox and one Pi session, so a later message continues the same work.
// Credentials are placeholders inside the sandbox; its network policy puts the real
// ones on the wire, so nothing in the sandbox can read them.

/** The production board the agent's `vb` talks to. */
const BOARD = "https://vboard-factory.playground-vercel.tools/api/board";
const MODEL = "anthropic/claude-opus-5.5";
/** The first Pi release that knows MODEL on AI Gateway. */
const PI = "@earendil-works/pi-coding-agent@1.0.0";
/** The `vb` Pi runs. A thread's sandbox outlives releases, so setup upgrades it in place. */
const VBOARD = "0.4.0";
/**
 * A sandbox session ends at a fixed deadline, not after idling; its files come back with the next one.
 * Each message gets at least this long before it, so a turn that starts late in a session isn't cut off.
 */
const SANDBOX_MS = 45 * 60_000;
const SNAPSHOT_MS = 7 * 24 * 60 * 60_000;

/** Commits are the factory GitHub App's, under its bot account's noreply address. */
const GIT_AUTHOR = { name: "vboard-factory[bot]", email: "338721338+vboard-factory[bot]@users.noreply.github.com" };

/** Who a thread's Pi is on the board: profile `pi`, in that thread's session. */
const piSession = (thread: number) => `thread-${thread}`;

/** Whether a message was written by the Pi working on `thread`. */
export const byPi = (thread: number, by: { profile: string | null; session: string | null }) =>
  by.profile === "pi" && by.session === piSession(thread);

/** The Slack workspace the factory syncs with. */
const SLACK = "https://vercel.slack.com";

/**
 * Where a thread came from, as a link Pi can put in its PR: a Slack thread's permalink or a GitHub issue or PR.
 * `origin.thread` is the sync target: `slack:C0123:1727000000.123456`, `github:owner/repo:issue:12`, `github:owner/repo:12`.
 */
export function sourceLink(origin: { thread: string } | null | undefined) {
  const thread = origin?.thread ?? "";
  const slack = /^slack:([A-Z0-9]+):(\d+)\.(\d+)$/.exec(thread);
  if (slack) return { platform: "Slack", url: `${SLACK}/archives/${slack[1]}/p${slack[2]}${slack[3]}` };
  const gh = /^github:([^/:]+\/[^/:]+):(issue:)?(\d+)$/.exec(thread);
  if (gh) return { platform: "GitHub", url: `https://github.com/${gh[1]}/${gh[2] ? "issues" : "pull"}/${gh[3]}` };
  return null;
}

/** The task message that starts Pi on a thread, with where it came from when it's synced. */
export function taskMessage(
  task: string,
  thread: { id: number; origin: { thread: string } | null; author?: { name: string } | null },
) {
  const source = sourceLink(thread.origin);
  const by = thread.author?.name ? ` by ${thread.author.name}` : "";
  return `There's ${task} in board thread #${thread.id}${source ? `, posted${by} on ${source.platform}: ${source.url}` : ""}.`;
}

/** What Pi does in a thread: work a firehose thread (bug, feature, question, task), or review a pull request. */
export type Task = "thread" | "review";

/** How Pi keeps people company in any thread: they see it's on it, and get pinged when it answers. */
const PRESENCE = `As soon as you've read a message from a person that you're about to act on, react to it with vb react <id> eyes, so they know you saw it.
When you reply to a person, mention them by the handle they wrote under (author.handle in vb read <id> --json, for example @JB), so they're notified on Slack or GitHub. If vb says the handle is ambiguous, use the actor ID it lists instead: @[slack:user:U0456]. Mention each person once, not in every line.
You hear about every reply in your threads, but most aren't for you. When a message is addressed to someone else (it @mentions another person, or answers someone else's question) and doesn't ask anything of you, don't reply and don't react; stay quiet unless you're asked.
Board replies are read on Slack by busy people: keep each to a few lines. Lead with the outcome (the PR link, the answer, the one question you need answered), skip background they already know, and use a short list only when there are real options to pick from. No "What I ran" lists, and no recaps of the thread, including messages synced from GitHub (PR descriptions, reviews and comments, yours too): point at them instead, and say each thing once; the attachments and the PR carry the detail.
Sound like a teammate in the channel, not a report: plain, direct sentences, the way the people in the thread write, minus their slang. Don't put on a casual voice ("lol", "bro", "fair", memes); match their directness, not their spelling. Start with the answer itself, not a preamble ("Not sure which you mean, so both", "Good question") or a label ("Done:", "Outcome:"). Don't hedge or pile on caveats, and leave out file paths, identifiers and API names unless someone asked where or how something works. End when you've said it: ask a question only when you need the answer to go on. Banter doesn't need an answer; when someone asks you something light, a short, light answer is fine.`;

const DIRECTION = `Your initial task is a starting point. People can redirect you in the thread at any time; follow their latest instructions even when they change the task, including fixing code, pushing changes, approving, marking a draft ready, merging, or closing a PR.
A person's :shipit: or :approved: reaction is a request to complete the merge. Inspect the PR, resolve the blockers you can, mark it ready if needed, and merge it when GitHub's checks and review requirements allow. Carry that intent through without requiring another reaction. If you need someone else's action, ask them in the thread and explain what's still blocking it.
A person's :security: reaction on a PR is a request for a deepsec review of its diff. React :secure: on the root only when deepsec exits 0.`;

const THREAD = `You own bug reports, feature requests, and questions for vboard (github.com/basehub-ai/vboard, private), a message board library and CLI.
The board is how you talk to people. vb read <id> shows a thread, vb reply <id> "<text>" answers in it (and reaches Slack or GitHub when the thread is synced), vb label <id> k=v labels it. Run vb help for the rest.
A thread's kind label (bug, feature, question, task) says what it is; judge it yourself from the whole thread too. Clone with gh repo clone basehub-ai/vboard; the repo uses pnpm (pnpm install, pnpm test). Any change you make goes on a branch named pi/<thread id> (never main), in a pull request opened with gh pr create, and you reply with the PR link.
Open the PR body with one line saying what triggered it, before anything else: "> 💬 From [<who>'s Slack thread](<link>) · board #<id>" for Slack, "> 🐙 From #<issue> on GitHub · board #<id>" for a GitHub issue (with "Closes #<issue>" below when the PR fixes it), or "> From board #<id>" when the thread has no source. Your task message gives the source link and who posted it.
For a bug report:
1. Reproduce it with a failing test.
2. If you reproduced it, label the thread reproduced=yes, fix it, and open a PR.
3. If you can't reproduce it, or it isn't a bug, label it reproduced=no and reply with why. If the thread came from a GitHub issue, close the issue with gh issue close and say why there too.
For a feature request: if it's clear what's wanted, build it with tests and open a PR. If it's ambiguous or large, reply with a short plan or your questions first, and build it once someone agrees.
For a question: answer it from the code and docs, pointing at the files. Don't open a PR unless someone asks for one.
For a task (someone asks you to do something, like a recap or an investigation): do it with what the board, the repo and GitHub show you, and reply with the result.
Show your work only when it's worth looking at: when the change is something people can see and you can capture it, attach a screenshot to the reply that links the PR, with --attach <file> (up to 4 MB). Don't attach test runs or logs of your own checks: the tests go in the PR, and for a bug, name the test that reproduces it in the PR body. People see attachments in Slack and vb inspect; GitHub gets a line pointing at the board.
vb read lists a message's files as 📎 lines with an ID; vb download <id> saves one, so look at screenshots and logs people attach.
When you're told there's new activity in a thread, read it, see what's new since you last replied, and act on it if it's for you.`;

const REVIEW = `Your initial task is to review a pull request for vboard (github.com/basehub-ai/vboard, private), a message board library and CLI.
The board is how you talk to people. vb read <id> shows a thread, vb reply <id> "<text>" answers in it (and reaches Slack and the PR on GitHub), vb label <id> k=v labels it. Run vb help for the rest.
For a pull request (its board thread's root has a pr=owner/repo#N label):
1. Clone with gh repo clone basehub-ai/vboard, then gh pr checkout <N>. Read gh pr view <N> and gh pr diff <N>, and SPEC.md and AGENTS.md for the parts it touches.
2. Run pnpm install and pnpm check. Try the change where you can: a test that should fail without it, or the CLI by hand.
3. Put the detail on GitHub, attached to the code: submit one review with gh api repos/basehub-ai/vboard/pulls/<N>/reviews --input review.json (event COMMENT, REQUEST_CHANGES or APPROVE, with comments on file:line for each problem and suggestion). You review as vboard-factory[bot], and GitHub rejects APPROVE and REQUEST_CHANGES on that account's own PRs, so on a PR it opened use COMMENT and put the verdict in the body. Inline comments must be on lines the diff touches, or GitHub rejects the whole review; put anything else in the body. Always put the verdict in the body, even when the problems are all inline (a review with an empty body never reaches the board), and keep the body short: the verdict (good to merge, or the blocking problems in a line each), with the detail in the inline comments. The review shows up in the board thread and on Slack on its own, so don't restate it there: reply in the board thread only to add what it lacks, in a line (the mention of whoever asked, or what you tried by hand attached with --attach <file>, a log or a screenshot, up to 4 MB each), or not at all. vb read lists files people attached as 📎 lines; vb download <id> saves one.
When you're told there's new activity in a thread, read it, see what's new since you last replied, and act on it if it's for you: answer questions, and review again if new commits landed (gh pr view <N> --json commits).`;

export const INSTRUCTIONS: Record<Task, string> = {
  thread: `${THREAD}\n${PRESENCE}\n${DIRECTION}`,
  review: `${REVIEW}\n${PRESENCE}\n${DIRECTION}`,
};

const SETUP = `set -e
command -v pi >/dev/null || npm install -g ${PI} pnpm >/dev/null 2>&1
# Pinned like pi. If that release isn't on npm yet, a vb already here stays, and a new sandbox gets the latest.
[ "$(vb --version 2>/dev/null)" = "${VBOARD}" ] || npm install -g vboard@${VBOARD} >/dev/null 2>&1 || command -v vb >/dev/null || npm install -g vboard >/dev/null 2>&1
command -v gh >/dev/null || {
  v=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p')
  curl -fsSL "https://github.com/cli/cli/releases/download/v$v/gh_\${v}_linux_amd64.tar.gz" | tar xz -C /tmp
  install "/tmp/gh_\${v}_linux_amd64/bin/gh" /usr/local/bin/gh
}`;

/**
 * One message, once: KEY marks it delivered, so a retried watcher doesn't send it
 * twice. The lock queues it behind a turn that's still running, and the session ID
 * makes it a continuation of everything Pi has done in this thread.
 */
const TELL = `mkdir -p ~/.pi/told
[ -e ~/.pi/told/"$KEY" ] && exit 0
touch ~/.pi/told/"$KEY"
cd ~ && exec flock ~/.pi/lock pi -p --provider vercel-ai-gateway --model "$MODEL" --session-id "$SESSION" \\
  --append-system-prompt "$INSTRUCTIONS" "$MESSAGE" >> ~/pi.log 2>&1`;

/**
 * Real credentials on the way out: the deployment's OIDC token, and the factory GitHub App's.
 * On the board, the policy also sets who Pi is, so nothing in the sandbox can post as anyone else.
 */
function policy(thread: number, tokens: { gateway: string; board: string; github: string }): NetworkPolicy {
  const basic = Buffer.from(`x-access-token:${tokens.github}`).toString("base64");
  return {
    allow: {
      // Pi speaks the Anthropic messages API to AI Gateway, which reads x-api-key.
      "ai-gateway.vercel.sh": [
        { transform: [{ headers: { "x-api-key": tokens.gateway, authorization: `Bearer ${tokens.gateway}` } }] },
      ],
      [new URL(BOARD).host]: [
        {
          transform: [
            {
              headers: {
                authorization: `Bearer ${tokens.board}`,
                "x-board-profile": "pi",
                "x-board-session": piSession(thread),
                ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
                  ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
                  : {}),
              },
            },
          ],
        },
      ],
      "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }],
      "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${tokens.github}` } }] }],
      "*": [],
    },
  };
}

/** How much to extend a session ending at `expiresAt` so a turn starting `now` gets SANDBOX_MS: 0 if it already has that. */
export function extension(expiresAt: Date | undefined, now: number) {
  if (!expiresAt) return 0;
  return Math.max(0, SANDBOX_MS - (expiresAt.getTime() - now));
}

async function sh(sandbox: Sandbox, script: string) {
  const done = await sandbox.runCommand({ cmd: "bash", args: ["-c", script], sudo: true });
  if (done.exitCode !== 0) throw new Error(`sandbox setup failed: ${(await done.stderr()).slice(-500)}`);
}

/**
 * Sends Pi a message about a thread: the first one is its task (a thread to work or a PR to review), later ones say
 * there's news. Pi's sandbox and session for the thread are created on first use.
 * `key` names the message, so telling Pi the same thing twice is a no-op.
 */
export async function tellPi({
  task,
  thread,
  key,
  message,
}: {
  task: Task;
  thread: number;
  key: string;
  message: string;
}) {
  const [{ Sandbox }, { getToken }, { getVercelOidcToken }] = await Promise.all([
    import("@vercel/sandbox"),
    import("@vercel/connect"),
    import("@vercel/oidc"),
  ]);
  const settings = {
    name: `pi-${thread}`,
    runtime: "node24",
    timeout: SANDBOX_MS,
    persistent: true,
    snapshotExpiration: SNAPSHOT_MS,
    env: {
      AI_GATEWAY_API_KEY: "from-the-network-policy",
      VBOARD_URL: BOARD,
      VBOARD_TOKEN: "from-the-network-policy",
      GH_TOKEN: "from-the-network-policy",
    },
  } as const;
  let sandbox = await Sandbox.getOrCreate(settings);
  // Stopped with nothing to resume (its snapshot expired): the thread starts over in a new one.
  if (sandbox.status === "stopped" && !sandbox.currentSnapshotId) {
    await sandbox.delete();
    sandbox = await Sandbox.create(settings);
  }
  // Every turn, so a sandbox picks up a new pinned vb; before the policy, so no credential is in place yet.
  await sh(sandbox, SETUP);
  // Fresh tokens with every message, so a thread can pick up again days later.
  const [gateway, board, github] = await Promise.all([
    getVercelOidcToken(),
    getVercelOidcToken({ audience: BOARD }),
    getToken("github/vboard-factory", { subject: { type: "app" } }),
  ]);
  await sandbox.update({ networkPolicy: policy(thread, { gateway, board, github }) });
  // A message landing late in a session (say, one started by an earlier turn) still gets a full SANDBOX_MS.
  const extend = extension(sandbox.expiresAt, Date.now());
  if (extend > 0) await sandbox.extendTimeout(extend);
  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", TELL],
    env: {
      MODEL,
      SESSION: piSession(thread),
      INSTRUCTIONS: INSTRUCTIONS[task],
      KEY: key,
      MESSAGE: message,
      // Over any git config Pi writes: otherwise it picks an identity, and GitHub credits a stranger.
      GIT_AUTHOR_NAME: GIT_AUTHOR.name,
      GIT_AUTHOR_EMAIL: GIT_AUTHOR.email,
      GIT_COMMITTER_NAME: GIT_AUTHOR.name,
      GIT_COMMITTER_EMAIL: GIT_AUTHOR.email,
    },
    detached: true,
  });
}
