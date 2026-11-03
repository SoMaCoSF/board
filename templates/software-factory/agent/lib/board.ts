// The thread a session works on, and the GitHub access the board gives it: sent with each message,
// kept in the turn's auth by channels/eve.ts.

export type BoardTask = { thread: string; github: string | null; repos: string[] };

const THREAD = /^[A-Za-z0-9_-]{1,64}$/;
const CONNECTOR = /^github\/[A-Za-z0-9_.-]{1,64}$/;
/** `owner/name` as GitHub allows them: an owner is letters, digits and hyphens, a name isn't `.` or `..`. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

export function boardFrom(context: unknown): BoardTask | null {
  const board = (context as { board?: { thread?: unknown; github?: unknown; repos?: unknown } } | null)?.board;
  if (typeof board?.thread !== "string" || !THREAD.test(board.thread)) return null;
  const github = typeof board.github === "string" && CONNECTOR.test(board.github) ? board.github : null;
  const repos = Array.isArray(board.repos) ? board.repos.filter((repo): repo is string => typeof repo === "string" && REPO.test(repo)) : [];
  return { thread: board.thread, github, repos };
}

type Auth = { attributes: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

/** What `boardFrom` found, as the channel keeps it in auth attributes. */
export const attributes = (board: BoardTask) => ({
  boardThread: board.thread,
  ...(board.github ? { boardGithub: board.github } : {}),
  boardRepos: board.repos,
});

export function boardOf(session: { auth: { current: Auth; initiator: Auth } }): BoardTask | null {
  for (const auth of [session.auth.current, session.auth.initiator]) {
    const found = auth?.attributes;
    const board = boardFrom({ board: { thread: found?.boardThread, github: found?.boardGithub, repos: found?.boardRepos } });
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
