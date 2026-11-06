import type { Watcher } from "@vercel/board";
import { byEve, byWatcher, eveName, taskMessage, type tellEve } from "./agent.ts";
import { isEveKind, eveTask, scheduled, scheduledThread, EVE_KINDS } from "./kinds.ts";

/** What people call the factory, or a thread's Eve, when they @ it. */
const FACTORY = new Set(["factory", "vboard", "vboard-factory", "eve", "pi", "agent", "bot"]);
/** The factory named anywhere in the text: "@JB and factory, take a look" is for Eve too. */
const NAMES_FACTORY = /(?<![\w@/-])(?:factory|vboard|eve)(?![\w-])/i;
/** The @mentions a message opens with: `@hacker`, `@julian/claude`, `@[slack:user:U0456]`, a few in a row. */
const LEADING = /^\s*((?:@\[[^\]\s]+\]|@[a-z0-9][\w./-]*)[\s,:]*)+/i;
const MENTION = /@\[([^\]\s]+)\]|@([a-z0-9][\w./-]*[a-z0-9]|[a-z0-9])/gi;

/**
 * Whether a message is addressed to someone else: it opens by @mentioning people or other bots
 * (`@hacker Do a full security review…`) and never names the factory or this thread's Eve.
 * It reads the text, not the resolved mentions: a Slack user the board hasn't met yet (another
 * bot, a first-time poster) comes in as plain `@handle` text with no mention (board thread #7775).
 */
export function forSomeoneElse(text: string, thread: string): boolean {
  const leading = LEADING.exec(text)?.[0];
  if (!leading) return false;
  const ours = (name: string) => {
    const handle = name.toLowerCase();
    return FACTORY.has(handle) || handle === eveName(thread) || handle.startsWith("vboard-factory/");
  };
  const addressed = [...leading.matchAll(MENTION)].map((m) => m[1] ?? m[2]!);
  if (addressed.some(ours)) return false;
  return !NAMES_FACTORY.test(text.slice(leading.length));
}

/**
 * Eve watches every thread worth acting on (bugs, features, questions, tasks; not noise): it
 * gets the thread once triage gives it one of those kinds, is told again if the kind changes,
 * and hears when anyone else replies, then reads what's new itself. A thread or reply addressed
 * to someone else (`@hacker …`) isn't Eve's: it hears nothing of it.
 */
export function pi(options: { tellEve: typeof tellEve }): Watcher {
  return {
    tail: `dev --label kind=${EVE_KINDS.join("|")}`,
    run: async ({ event, board }) => {
      const message = event.message;
      if (!message) {
        return;
      }
      const kind =
        event.type === "labels.changed"
          ? event.payload.set.kind
          : event.type === "message.posted"
            ? scheduledThread(message) ?? undefined
            : undefined;
      if (kind && isEveKind(kind) && message.re === null) {
        if (!scheduled(message) && forSomeoneElse(message.text, message.id)) {
          return;
        }
        await options.tellEve({
          board,
          task: "thread",
          thread: message.id,
          key: `kind-${kind}`,
          message: taskMessage(eveTask(kind), message),
        });
      } else if (
        event.type === "message.posted" &&
        message.re !== null &&
        (scheduled(message) || (!byEve(message.re, message.by) && !forSomeoneElse(message.text, message.re))) &&
        !byWatcher(message.by)
      ) {
        await options.tellEve({
          board,
          task: "thread",
          thread: message.re,
          key: `news-${message.id}`,
          message: `There's new activity in board thread #${message.re}.`,
        });
      }
    },
  };
}
