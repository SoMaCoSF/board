import type { Board, MessageView, ThreadSummaryView } from "@vercel/board";
import { FLEET, NAME, team } from "./board.ts";
import { FINISHED, OPEN, STATES, type State } from "./queue.ts";

/** A message as the page shows it. */
export type Line = { id: string; channel: string; re: string | null; author: string; text: string; at: string };

/** A task: a thread the board keeps a task's state on, under the fleet. */
export type Task = {
  id: string;
  channel: string;
  title: string;
  state: State;
  /** Who holds it, by handle where the page has seen one, while it's claimed. */
  holder: string | null;
  /** When the claim runs out. A claimed task past it has stalled, and anyone may take it over. */
  until: string | null;
  /** The tasks it waits for. */
  needs: string[];
  /** What it came to, why it failed or was canceled, or what it's held for. */
  note: string | null;
  author: string;
  replies: number;
  last: Line | null;
  createdAt: string;
};

export type Snapshot = {
  name: string;
  fleet: string;
  /** The board's position this was read at: the live route follows on from it. */
  cursor: string;
  at: string;
  /** Every open task, and the latest few finished ones. */
  tasks: Task[];
  /** True when there are more finished tasks than `tasks` holds, so a count of them is a floor. */
  finishedCapped: boolean;
  /** The latest messages under the fleet, newest first. */
  flow: Line[];
};

const author = (message: MessageView) => message.author?.handle ?? message.by.actor;

const line = (message: MessageView): Line => ({
  id: message.id,
  channel: message.channel,
  re: message.re,
  author: author(message),
  text: message.text,
  at: message.createdAt,
});

const OPEN_LIMIT = 200;
const FINISHED_LIMIT = 25;

/** A summary as a task, named by `handles` where it can be: a claim says who holds it by actor ID. */
function toTask({ message, replies, last }: ThreadSummaryView, handles: Map<string, string>): Task[] {
  const task = message.task;
  if (!task || !STATES.includes(task.state)) return [];
  const holder = task.state === "claimed" && task.claim ? task.claim.actor : null;
  return [
    {
      id: message.id,
      channel: message.channel,
      title: message.text.split("\n", 1)[0] || "(no title)",
      state: task.state,
      holder: holder && (handles.get(holder) ?? holder),
      until: task.state === "claimed" ? (task.claim?.until ?? null) : null,
      needs: task.needs,
      note: task.result ?? task.reason ?? task.blocked?.reason ?? null,
      author: author(message),
      replies,
      last: last ? line(last) : null,
      createdAt: message.createdAt,
    },
  ];
}

/**
 * The fleet as it is now: its newest messages, then one read per task state. Open tasks are a
 * `tasks` list each, which is also a task request: on Vercel's board, which keeps no timers, it's
 * what turns a lapsed claim ready and readies a task whose prerequisites completed. A list goes
 * oldest first, so the newest few finished tasks are read as threads by the state's label
 * (`board.task`), newest first, with a small limit; Vercel's board still pages through every
 * finished task to find them. Nothing is kept between snapshots: each is the board as it is,
 * whoever asks and whatever they missed.
 */
export async function snapshot(board: Board = team(), fleet: string = FLEET): Promise<Snapshot> {
  // The messages first: their cursor is where the live route listens from, so a change that lands
  // between the reads is in the next snapshot rather than in neither.
  const page = await board.messages({ channel: fleet, limit: 100 });
  const [open, finished] = await Promise.all([
    Promise.all(OPEN.map(async (state) => (await board.tasks.list({ channel: fleet, state, limit: OPEN_LIMIT })).tasks)),
    Promise.all(
      FINISHED.map(async (state) => (await board.threads({ channel: fleet, label: { "board.task": state }, limit: FINISHED_LIMIT })).threads),
    ),
  ]);
  // Who an actor is, from what the page has: the fleet's messages, and each task's root and last reply.
  const handles = new Map<string, string>();
  const seen = (message: MessageView | null) => message?.author?.handle && handles.set(message.by.actor, message.author.handle);
  for (const message of page.messages) seen(message);
  for (const summary of [...open, ...finished].flat()) seen(summary.message), seen(summary.last);
  // The board lists oldest first; the page reads newest first, state by state.
  const tasks = (summaries: ThreadSummaryView[]) => summaries.flatMap((summary) => toTask(summary, handles)).reverse();
  return {
    name: NAME,
    fleet,
    cursor: page.cursor,
    at: new Date().toISOString(),
    tasks: [...open.flatMap(tasks), ...finished.flatMap(tasks)],
    finishedCapped: finished.some((threads) => threads.length >= FINISHED_LIMIT),
    flow: page.messages.map(line).reverse(),
  };
}

/** One task's thread: its brief, its labels, and its work log. Only a thread under the fleet. */
export async function history(id: string): Promise<{ root: Line; labels: Record<string, string>; replies: Line[] }> {
  const { message, replies } = await team().thread(id);
  if (!message.channel.startsWith(FLEET)) throw new Error(`${id} isn't in ${FLEET}`);
  return { root: line(message), labels: message.labels, replies: replies.map(line) };
}
