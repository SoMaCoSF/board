import type { Board, MessageView } from "@vercel/board";
import type { AgentMessage } from "../agent/lib/wake.ts";

// The factory's first task: making this copy of the template the team's own, starting with its
// README. It's something to see work, end to end, that someone would have to do anyway.

/** Where the page, or an agent setting the factory up, starts it: a POST. */
export const FIRST_TASK_PATH = "/api/launcher/first-task";

/** The label its thread carries, which is how the page knows it started. */
export const FIRST_TASK_LABEL = "first-task";

/** What the factory tells itself to do, as the thread's first message. */
export const FIRST_TASK_TEXT =
  "First task: make this repo's README ours. It's still the template's. Cut what's about making a copy of it (the Deploy button, the steps to set one up) and what would be true of any factory, and keep what's true of this one: what it's for, its repos and channels, and how to change it.";

/** Whether a README is still the template's: it carries the button that deploys a copy of it. Nothing to read is no. */
export const templateReadme = (readme: string | undefined): boolean => readme?.includes("https://vercel.com/new/clone") ?? false;

/**
 * Where the first task stands: on `offer` while the README is still the template's and it hasn't
 * started, `started` once its thread is there, and nothing once the README is the team's own.
 */
export type FirstTask = "offer" | "started" | null;

export function firstTask(readme: string | undefined, threads: MessageView[]): FirstTask {
  if (!templateReadme(readme)) return null;
  return threads.some((message) => message.labels[FIRST_TASK_LABEL]) ? "started" : "offer";
}

/**
 * Starts it: the factory opens the thread itself, where it changes itself, and hands it to its
 * agent as the watcher would. The agent's own message wakes nobody, so the wake-up is sent here.
 * Asked twice, it starts once: the post carries an ID the board keeps one message for, and the
 * wake-up a key the agent's channel takes once. The ID names the channel, since a board keeps one
 * message per ID and a team's factories share a board.
 */
export async function startFirstTask(agent: Pick<Board, "post">, channel: string, wake: (message: AgentMessage) => Promise<void>): Promise<MessageView> {
  const root = await agent.post(channel, { text: FIRST_TASK_TEXT, labels: { [FIRST_TASK_LABEL]: "readme" }, id: `${FIRST_TASK_LABEL}:${channel.replaceAll("/", ".")}` });
  await wake({ thread: root.id, key: `${FIRST_TASK_LABEL}-${root.id}`, text: `New board thread #${root.id}.` });
  return root;
}

/** Whether a request comes from this deployment's own page, or from something that isn't a browser: another site can't start anything with a visitor's session. */
export const ownRequest = (origin: string | null, host: string): boolean => {
  if (origin === null) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};
