import { byPi, byWatcher, piName } from "./agent.ts";
import { scheduled } from "./kinds.ts";

// When `review-pi` starts Pi reviewing a PR. A draft isn't ready for review, so its thread
// waits: Pi reviews a PR when it opens ready, or when it leaves draft. The GitHub sync keeps a
// PR root's `state` label (`draft`, `open`, `merged`, `closed`), and marking a draft ready
// relabels the root `state=open`.

/** Whether a PR root is a draft. A root with no `state` label (synced before it had one) counts as ready. */
export const isDraft = (labels: Record<string, string>) => labels.state === "draft";

/**
 * Whether an event on a PR root is the moment to review it: the root posted ready, or relabeled
 * `state=open` (marked ready, or reopened). The review's tellPi key is `pr`, which Pi takes once
 * per thread, so a PR opened ready and later reopened is still reviewed once.
 */
export function reviewStarts(event: {
  type: string;
  payload: unknown;
  message?: { re: string | null; labels: Record<string, string> };
}) {
  const message = event.message;
  if (!message || message.re !== null) return false;
  if (event.type === "message.posted") return !isDraft(message.labels);
  if (event.type === "labels.changed") return (event.payload as { set?: Record<string, string> }).set?.state === "open";
  return false;
}

/**
 * Whether a reply in a draft PR's thread asks Pi itself: it names Pi (`pi`, `@pi`, `Pi,`) or this
 * thread's Pi by its own name. Kept to the text, so it can misfire on a reply about Pi; that wakes
 * Pi, which stays quiet when a reply isn't for it.
 */
export const asksPi = (thread: string, text: string) =>
  /(^|[^\w/-])@?pi(?![\w/-])/i.test(text) || text.toLowerCase().includes(piName(thread));

type Reply = {
  re: string | null;
  text: string;
  by: { actor: string; principal: string; profile: string | null; session: string | null };
  author: { bot?: true } | null;
  schedule?: unknown;
};

/**
 * Whether a reply in a PR thread wakes Pi: anyone's but a platform bot's (Vercel's deploy comments, CI), a
 * watcher's, or Pi's own, though a reminder Pi scheduled for itself counts. In a draft, only that reminder or a
 * reply asking Pi does. `draft` reads the thread, so it's asked last.
 */
export async function wakesReview(reply: Reply, draft: (thread: string) => Promise<boolean>) {
  if (reply.re === null || reply.author?.bot || byWatcher(reply.by)) return false;
  const own = byPi(reply.re, reply.by);
  if (own && !scheduled(reply)) return false;
  return own || asksPi(reply.re, reply.text) || !(await draft(reply.re));
}
