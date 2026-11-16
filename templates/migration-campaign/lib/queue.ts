import { randomUUID } from "node:crypto";
import { BoardError, type Board, type ThreadSummaryView } from "@vercel/board";
import { LABEL, LEASE_MS, note, type State } from "../sandbox/shared.ts";

// A campaign's work queue: a thread's root is a task, its replies are the work log, and the root's
// labels hold the state. Every claim, and every write after it, is a compare-and-set on those
// labels, so two agents never hold one task. The agents in the sandboxes take the same steps with
// `vb label --if` (sandbox/runner.ts); this is the app's side, and what the tests and the demo use.
//
// It's the one place that knows a task is labels. A board whose `tasks` are available where you run
// could keep the state itself: swap this file and the runner's claim, and nothing else changes.

const lease = () => new Date(Date.now() + LEASE_MS).toISOString();

/** True when the board refused the write because a label wasn't what `if` said. */
const lost = (error: unknown) => error instanceof BoardError && error.code === "label_conflict";

/** Runs a compare-and-set. False when it lost: someone changed the task first, and nothing was written. */
async function cas(write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return true;
  } catch (error) {
    if (lost(error)) return false;
    throw error;
  }
}

/** How many tasks are posted at once: enough to be quick, few enough that the board doesn't throttle a launch. */
const POSTING = 6;

/**
 * Posts the campaign's tasks, ready, in the order given. Each has a key of its own, so a launch
 * that's tried again posts none twice.
 */
export async function createTasks(board: Board, channel: string, key: string, texts: string[]): Promise<number> {
  for (let at = 0; at < texts.length; at += POSTING) {
    await Promise.all(texts.slice(at, at + POSTING).map((text, offset) => board.post(channel, { text, labels: { [LABEL.state]: "ready" }, id: `${key}-${at + offset}` })));
  }
  return texts.length;
}

export type Claim = { id: string; token: string };

/** Claims a task for `owner`: a ready one, or with `stalled`, a claimed one whose token is still the stalled claim's. Null: someone was first. */
export async function claim(board: Board, id: string, owner: string, stalled?: string): Promise<Claim | null> {
  const token = randomUUID();
  const won = await cas(
    board.label(id, {
      set: { [LABEL.state]: "claimed", [LABEL.owner]: owner, [LABEL.claim]: token, [LABEL.lease]: lease() },
      unset: [LABEL.note, LABEL.kind],
      if: stalled ? { [LABEL.claim]: stalled } : { [LABEL.state]: "ready" },
    }),
  );
  return won ? { id, token } : null;
}

/**
 * Claims the oldest task `owner` can take in a channel: a ready one first, then one whose claim
 * ran out. Null when there's nothing to take right now.
 */
export async function claimNext(board: Board, channel: string, owner: string): Promise<(Claim & { text: string }) | null> {
  const ready = await board.threads({ channel, label: { [LABEL.state]: "ready" }, limit: 20 });
  // The board lists by latest activity, newest last: the oldest first is the order a queue works in.
  for (const { message } of ready.threads) {
    const held = await claim(board, message.id, owner);
    if (held) return { ...held, text: message.text };
  }
  const claimed = await board.threads({ channel, label: { [LABEL.state]: "claimed" }, limit: 50 });
  const now = new Date().toISOString();
  for (const { message } of claimed.threads) {
    const stale = message.labels[LABEL.lease];
    const token = message.labels[LABEL.claim];
    if (!token || !stale || stale > now) continue;
    const held = await claim(board, message.id, owner, token);
    if (held) return { ...held, text: message.text };
  }
  return null;
}

/** Extends the lease. False: the claim is someone else's now, so stop working on the task. */
export const renew = (board: Board, held: Claim) => cas(board.label(held.id, { set: { [LABEL.lease]: lease() }, if: { [LABEL.claim]: held.token } }));

/** Ends a claim as `completed`, with how it went in a line. False: the claim was lost, and nothing changed. */
export const complete = (board: Board, held: Claim, result: string) =>
  cas(board.label(held.id, { set: { [LABEL.state]: "completed", [LABEL.note]: note(result) }, unset: [LABEL.claim, LABEL.lease, LABEL.kind], if: { [LABEL.claim]: held.token } }));

/** Ends a claim by holding the task for a person, with why. False: the claim was lost. */
export const block = (board: Board, held: Claim, reason: string, kind = "needs_input") =>
  cas(board.label(held.id, { set: { [LABEL.state]: "blocked", [LABEL.note]: note(reason), [LABEL.kind]: kind }, unset: [LABEL.claim, LABEL.lease], if: { [LABEL.claim]: held.token } }));

/** Lifts a hold: the task is ready again. It holds no claim, so it fences on the state. False: it wasn't held. */
export const unblock = (board: Board, id: string) =>
  cas(board.label(id, { set: { [LABEL.state]: "ready" }, unset: [LABEL.owner, LABEL.note, LABEL.kind], if: { [LABEL.state]: "blocked" } }));

/** Calls a task off, whatever state it's in: an agent that holds it loses its claim, and settles nothing. */
export const cancel = (board: Board, id: string, why: string) => board.label(id, { set: { [LABEL.state]: "canceled", [LABEL.note]: note(why) }, unset: [LABEL.claim, LABEL.lease, LABEL.kind] });

const PAGE = 500;

/** Every task of a channel in one state, a page at a time, up to `max`. */
export async function inState(board: Board, channel: string, state: State, max: number): Promise<ThreadSummaryView[]> {
  const found: ThreadSummaryView[] = [];
  let before: string | undefined;
  while (found.length < max) {
    // Before its first task, a campaign's channel isn't there: Vercel's board answers 404 for it, and a local one an empty list.
    const page = await board.threads({ channel, label: { [LABEL.state]: state }, limit: PAGE, ...(before ? { before } : {}) }).catch((error: unknown) => {
      if (error instanceof BoardError && error.status === 404) return { threads: [], older: null };
      throw error;
    });
    found.push(...page.threads);
    if (!page.older || page.threads.length === 0) break;
    before = page.older;
  }
  return found;
}
