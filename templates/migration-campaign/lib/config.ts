// What a campaign is, as the form sends it and the board keeps it: a campaign's thread carries its
// config as JSON, so anyone reading the board sees exactly what its agents were told.

export const DELIVERIES = ["patch", "prs", "branch"] as const;
export type Delivery = (typeof DELIVERIES)[number];

export const THINKING = ["low", "medium", "high"] as const;
export type Thinking = (typeof THINKING)[number];

export type Config = {
  /** What people call it: the campaign thread's first line. */
  title: string;
  /** The repository to migrate: `owner/name` on GitHub, or any https git URL. */
  repo: string;
  /** The branch to start from. Empty for the repository's default. */
  branch: string;
  /** The migration, in words: what to change, what to leave, and what done means. Every agent reads it. */
  instructions: string;
  /** A shell command, run once in the checkout, that prints the files to migrate, one per line. */
  discover: string;
  /** A shell command run once after the clone, before the checkout is copied to every agent: installing dependencies, say. */
  setup: string;
  /** A shell command that must exit 0 after a task's change. `{files}` becomes the task's files. Empty for none. */
  verify: string;
  /** How many files one task holds. */
  batch: number;
  /** The most tasks a campaign makes: what `discover` prints past it is left out, and said so. */
  maxTasks: number;
  /** How many agents work the queue, each in a sandbox of its own. */
  agents: number;
  /** The model that makes the change, by its AI Gateway ID. */
  model: string;
  /** Whether a second model reads each diff, with no context but the instructions, before it's delivered. */
  review: boolean;
  /** The model that reviews. */
  reviewModel: string;
  /** How many times an agent may try again after a failed verify or a review that asks for changes. */
  rounds: number;
  thinking: Thinking;
  /** How a finished task leaves the sandbox: a patch on its thread, a pull request each, or commits on one branch. */
  delivery: Delivery;
  /** What the campaign may spend on models, in dollars. Past it, its agents stop. */
  budgetUsd: number;
  /** How long the campaign runs at most. */
  minutes: number;
  /** vCPUs per sandbox: each gets 2 GB of memory per vCPU. */
  vcpus: number;
};

/** The most agents a campaign runs. Vercel's board gives one project 20 agent profiles, and each agent is one. */
export const MAX_AGENTS = 16;

export const DEFAULTS: Config = {
  title: "",
  repo: "",
  branch: "",
  instructions: "",
  discover: "git ls-files '*.js'",
  setup: "",
  verify: "",
  batch: 1,
  maxTasks: 200,
  agents: 4,
  model: "anthropic/claude-sonnet-5.5",
  review: true,
  reviewModel: "openai/gpt-6-sol",
  rounds: 2,
  thinking: "low",
  delivery: "patch",
  budgetUsd: 20,
  minutes: 45,
  vcpus: 2,
};

/** A campaign to try the template with: a public repository, a change any model can make, and a check that costs nothing. */
export const SAMPLE: Config = {
  ...DEFAULTS,
  title: "var to const and let in express's examples",
  repo: "expressjs/express",
  instructions: [
    "Replace every `var` declaration with `const`, or with `let` where the variable is reassigned.",
    "Change nothing else: no reformatting, no renames, no new imports, and no edits outside the task's files.",
    "A file with no `var` in it needs no change.",
  ].join("\n"),
  discover: "git ls-files 'examples/**/*.js'",
  verify: 'for f in {files}; do node --check "$f" || exit 1; done',
  batch: 2,
  maxTasks: 12,
  agents: 3,
  model: "anthropic/claude-haiku-5.5",
  reviewModel: "openai/gpt-6-luna",
  budgetUsd: 5,
  minutes: 20,
};

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

const whole = (value: unknown, fallback: number, min: number, max: number) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

const one = <T extends string>(value: unknown, of: readonly T[], fallback: T): T => (of.includes(value as T) ? (value as T) : fallback);

/** `owner/name`, as GitHub writes it, from that or from a GitHub URL. Null for a repository somewhere else. */
export function githubRepo(repo: string): string | null {
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
  return match ? match[1]! : null;
}

/** The URL git clones: GitHub's for `owner/name`, or the https URL given. */
export const cloneUrl = (repo: string) => (githubRepo(repo) ? `https://github.com/${githubRepo(repo)}.git` : repo.trim());

/** A model's AI Gateway ID: `creator/model`. */
const MODEL = /^[\w.-]+\/[\w.:-]+$/;

/**
 * A config from whatever the form sent, every number held to its range, or what's wrong with it in
 * words a person can act on. It's the only way a config is made, so a campaign the board holds was
 * checked here.
 */
export function parseConfig(input: unknown): { config: Config } | { problem: string } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const config: Config = {
    title: text(raw.title, 120),
    repo: text(raw.repo, 300),
    branch: text(raw.branch, 200),
    instructions: text(raw.instructions, 6_000),
    discover: text(raw.discover, 1_000),
    setup: text(raw.setup, 1_000),
    verify: text(raw.verify, 1_000),
    batch: whole(raw.batch, DEFAULTS.batch, 1, 50),
    maxTasks: whole(raw.maxTasks, DEFAULTS.maxTasks, 1, 2_000),
    agents: whole(raw.agents, DEFAULTS.agents, 1, MAX_AGENTS),
    model: text(raw.model, 100),
    review: raw.review === true || raw.review === "true" || raw.review === "on",
    reviewModel: text(raw.reviewModel, 100),
    rounds: whole(raw.rounds, DEFAULTS.rounds, 0, 5),
    thinking: one(raw.thinking, THINKING, DEFAULTS.thinking),
    delivery: one(raw.delivery, DELIVERIES, DEFAULTS.delivery),
    budgetUsd: whole(raw.budgetUsd, DEFAULTS.budgetUsd, 1, 10_000),
    minutes: whole(raw.minutes, DEFAULTS.minutes, 5, 300),
    vcpus: whole(raw.vcpus, DEFAULTS.vcpus, 1, 8),
  };
  if (!config.repo) return { problem: "Name the repository to migrate." };
  if (!githubRepo(config.repo) && !/^https:\/\/[\w.-]+\/\S+$/.test(config.repo)) return { problem: "The repository is owner/name on GitHub, or an https URL." };
  if (config.branch && !/^[\w./-]+$/.test(config.branch)) return { problem: "That branch name has characters git refuses." };
  if (config.instructions.length < 20) return { problem: "Say what the migration is: the agents read nothing else about it." };
  if (!config.discover) return { problem: "Give the command that lists the files to migrate." };
  if (!MODEL.test(config.model)) return { problem: "Pick the model that makes the change." };
  if (config.review && !MODEL.test(config.reviewModel)) return { problem: "Pick the model that reviews, or turn review off." };
  if (config.delivery !== "patch" && !githubRepo(config.repo)) return { problem: "Pull requests and a branch need a repository on GitHub." };
  if (!config.title) config.title = `Migrate ${githubRepo(config.repo) ?? config.repo}`;
  return { config };
}

/** A campaign thread's text: its title, then its config as the JSON `readConfig` reads back. */
export const campaignText = (config: Config) => `${config.title}\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``;

/** The config a campaign thread carries, or null for a thread that isn't one. */
export function readConfig(threadText: string): Config | null {
  const match = /```json\n([\s\S]*?)\n```/.exec(threadText);
  if (!match) return null;
  try {
    const parsed = parseConfig(JSON.parse(match[1]!));
    return "config" in parsed ? parsed.config : null;
  } catch {
    return null;
  }
}

/** A task's text: a title a person can scan, then its files. */
export function taskText(files: string[]): string {
  const title = files.length === 1 ? files[0]! : `${files[0]} and ${files.length - 1} more`;
  return `${title}\n${files.map((file) => `- ${file}`).join("\n")}`;
}

/** What `discover` printed, as tasks' files: its paths, once each, `batch` to a task, `maxTasks` at most. `left` is how many paths didn't fit. */
export function plan(discovered: string, batch: number, maxTasks: number): { tasks: string[][]; left: number } {
  // A path with a space or a quote would break `{files}` in the verify command, so it's skipped rather than escaped wrong.
  const paths = [...new Set(discovered.split("\n").map((line) => line.trim()))].filter((path) => path && !path.startsWith("-") && /^[\w@./+=,:[\]()~-]+$/.test(path));
  const tasks: string[][] = [];
  for (let at = 0; at < paths.length && tasks.length < maxTasks; at += batch) tasks.push(paths.slice(at, at + batch));
  return { tasks, left: Math.max(0, paths.length - tasks.length * batch) };
}
