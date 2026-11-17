import { BoardError, type Board, type ClaimedTask } from "@vercel/board";

// The work queue is the board's tasks: a thread's root is the task, its replies are the work log,
// and the board keeps its state, its claim and lease, and what it waits for. The board fences every
// claim, so two agents never hold one task, and an agent that stalled past its lease can't settle a
// task someone has since taken over. These turn the races a fleet expects into null or false and
// throw everything else. JOIN.md gives agents the same steps as `vb tasks` commands.

/** A task's states, as the board names them. */
export const STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;
export type State = (typeof STATES)[number];
/** The states a task is still in play in. */
export const OPEN = ["waiting", "ready", "claimed", "blocked"] as const satisfies readonly State[];
/** The states a task ends in. */
export const FINISHED = ["completed", "failed", "canceled"] as const satisfies readonly State[];

/** True for a 409 that means someone else got there first, or the claim is over. */
const raced = (error: unknown, ...codes: string[]) => error instanceof BoardError && codes.includes(error.code);

/**
 * A task: its first line is the title, the rest the brief. `key` makes a retried create land once,
 * and `needs` makes it wait until each of those tasks has completed.
 */
export async function create(
  board: Board,
  channel: string,
  task: { title: string; brief?: string; key: string; needs?: string[] },
): Promise<string> {
  const { task: root } = await board.tasks.create(channel, {
    text: task.brief ? `${task.title}\n\n${task.brief}` : task.title,
    id: task.key,
    ...(task.needs?.length ? { needs: task.needs } : {}),
  });
  return root.id;
}

/**
 * Claims task `id`: a ready one, or a claimed one whose lease ran out, which is how a stalled task
 * is taken over. Null when it can't be had now: someone holds it, it waits for another task or a
 * person, it's someone else's to claim, or it's finished.
 */
export async function claim(board: Board, id: string): Promise<ClaimedTask | null> {
  try {
    return await board.tasks.claim(id);
  } catch (error) {
    if (raced(error, "task_claimed", "task_waiting", "task_blocked", "task_assigned", "task_finished")) return null;
    throw error;
  }
}

/** Extends the lease. Null: the claim is over (taken over, or past its lease), so stop working on the task. */
export async function renew(held: ClaimedTask): Promise<ClaimedTask | null> {
  try {
    return await held.renew();
  } catch (error) {
    if (raced(error, "claim_lost")) return null;
    throw error;
  }
}

/**
 * Ends the claim: `complete` with what it came to, which readies the tasks that waited for it;
 * `fail` with why; or `release` to give it back. False: the claim was lost, and nothing changed.
 */
export async function finish(held: ClaimedTask, how: "complete" | "fail" | "release", note?: string): Promise<boolean> {
  try {
    if (how === "complete") await held.complete(note);
    else if (how === "fail") await held.fail(note ?? "gave up");
    else await held.release();
    return true;
  } catch (error) {
    if (raced(error, "claim_lost")) return false;
    throw error;
  }
}
