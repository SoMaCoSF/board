// The thread a session works on: sent with each message, kept in the turn's auth by channels/eve.ts.

export type BoardTask = { thread: string };

const THREAD = /^[A-Za-z0-9_-]{1,64}$/;

export function boardFrom(context: unknown): BoardTask | null {
  const thread = (context as { board?: { thread?: unknown } } | null)?.board?.thread;
  return typeof thread === "string" && THREAD.test(thread) ? { thread } : null;
}

type Auth = { attributes: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

export function boardOf(session: { auth: { current: Auth; initiator: Auth } }): BoardTask | null {
  for (const auth of [session.auth.current, session.auth.initiator]) {
    const board = boardFrom({ board: { thread: auth?.attributes.boardThread } });
    if (board) return board;
  }
  return null;
}

type Caller = { principalType?: string } | null | undefined;

/**
 * Only this deployment's own watchers: `vercelOidc()` calls a token `runtime` when it's from this
 * project in this environment, and `service` for any other environment, so a preview can't drive
 * production.
 */
export const sameDeployment = <T extends Caller>(caller: T) =>
  caller?.principalType === "runtime" || caller?.principalType === "local-dev" ? caller : null;
