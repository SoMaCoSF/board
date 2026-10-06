import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Coding agents end each turn with a hook. `vb hooks install` adds one that asks
// the agent, once, to update the board when its turn didn't: it ends its reply
// with a `Board update: <summary>` line, which the hook posts to the branch's
// work thread. The agent runs nothing, so no sandbox or permission prompt gets
// in the way; the hook runs outside both. Deciding reads only a local marker,
// and the post itself happens in the background, so a turn never waits on it.

type Shape = 'nested' | 'flat'

/**
 * Where each agent keeps hooks, and which of its events run which of ours.
 * Claude Code and Codex read `{ hooks: { Stop: [{ hooks: [entry] }] } }`;
 * Cursor reads `{ version: 1, hooks: { stop: [entry] } }`.
 */
export const AGENTS = {
  claude: { name: 'Claude Code', shape: 'nested', events: { Stop: 'stop' }, file: () => join(homedir(), '.claude', 'settings.json') },
  codex: {
    name: 'Codex',
    shape: 'nested',
    events: { Stop: 'stop' },
    file: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
  },
  // Cursor's stop event has no reply text, and its response event can't ask for more: one of each.
  cursor: { name: 'Cursor', shape: 'flat', events: { stop: 'stop', afterAgentResponse: 'response' }, file: () => join(homedir(), '.cursor', 'hooks.json') },
} as const satisfies Record<string, { name: string; shape: Shape; events: Record<string, string>; file: () => string }>

export type HookAgent = keyof typeof AGENTS

type HookEntry = { type?: string; command: string; timeout?: number }
type Group = { matcher?: string; hooks?: HookEntry[] }
type Entries = (Group | HookEntry)[]
type HookConfig = { version?: number; hooks?: Record<string, Entries> } & Record<string, unknown>

const ours = (entry: { command?: string }) => / hook (stop|response) --agent /.test(entry.command ?? '')

function readConfig(path: string): HookConfig {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HookConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`can't read ${path}: ${(error as Error).message}`)
  }
}

/** Written to a sibling, then renamed: a crash never leaves an agent's settings half-written. */
function writeConfig(path: string, config: HookConfig) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.vboard-tmp`, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(`${path}.vboard-tmp`, path)
}

/** An event's entries without ours; a group left with no hooks goes too. */
function without(entries: Entries, shape: Shape): Entries {
  if (shape === 'flat') return entries.filter((entry) => !ours(entry as HookEntry))
  return entries
    .map((group) => ({ ...group, hooks: ((group as Group).hooks ?? []).filter((h) => !ours(h)) }))
    .filter((group) => group.hooks.length > 0)
}

/** Adds our hooks, replacing earlier ones of ours; everything else in the file stays. Answers whether it changed. */
export function installHook(agent: HookAgent, cli: string, flags = ''): boolean {
  const spec = AGENTS[agent]
  const config = readConfig(spec.file())
  const hooks = { ...config.hooks }
  for (const [event, sub] of Object.entries(spec.events)) {
    // `|| true`: whatever `cli` turns out to be (an older vboard without `hook` exits 2, which Claude Code
    // and Codex read as "keep going"), the hook can't fail a turn.
    const command = `${cli} hook ${sub} --agent ${agent}${flags} 2>/dev/null || true`
    const entry = spec.shape === 'flat' ? { command, timeout: 10 } : { hooks: [{ type: 'command', command, timeout: 10 }] }
    hooks[event] = [...without(hooks[event] ?? [], spec.shape), entry]
  }
  const next = { ...(spec.shape === 'flat' ? { version: 1 } : {}), ...config, hooks }
  if (JSON.stringify(next) === JSON.stringify(config)) return false
  writeConfig(spec.file(), next)
  return true
}

export function uninstallHook(agent: HookAgent): boolean {
  const spec = AGENTS[agent]
  if (installedHook(agent) === null) return false
  const config = readConfig(spec.file())
  const hooks = { ...config.hooks }
  for (const event of Object.keys(spec.events)) {
    const kept = without(hooks[event] ?? [], spec.shape)
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  // A file that held only our hooks (Cursor's, which we created) goes away with them.
  const rest = Object.keys(config).filter((key) => key !== 'hooks' && key !== 'version')
  if (rest.length === 0 && Object.keys(hooks).length === 0) unlinkSync(spec.file())
  else writeConfig(spec.file(), { ...config, hooks })
  return true
}

/** The command our turn-end hook runs for `agent`, if it's installed. */
export function installedHook(agent: HookAgent): string | null {
  const spec = AGENTS[agent]
  const config = readConfig(spec.file())
  const entries = Object.keys(spec.events).flatMap((event) => config.hooks?.[event] ?? [])
  const commands = spec.shape === 'flat' ? (entries as HookEntry[]) : entries.flatMap((group) => (group as Group).hooks ?? [])
  return commands.find((entry) => ours(entry) && / hook stop /.test(entry.command))?.command ?? null
}

// --- what the agent says ------------------------------------------------------------

/** The line an agent ends a reply with to update the board. */
export const UPDATE_LINE = 'Board update:'

/**
 * The update an agent wrote: the rest of its reply's last line, when that
 * line starts with `Board update:` (bold or quoted is fine); `skip` when it
 * has nothing to share; else null. Only that line ever leaves the machine,
 * so a reply that merely mentions the syntax posts nothing.
 */
export function boardUpdate(reply: string): string | 'skip' | null {
  const line = reply.trimEnd().split('\n').at(-1)!
  const match = /^[ \t>*_`-]*board update[*_`]*[ \t]*:[*_`]*(.*?)[*_`]*$/i.exec(line)
  const text = match?.[1]!.trim()
  // `<summary>` and the like: the syntax, quoted, not an update.
  if (!text || /^<[^>]*>$/.test(text)) return null
  return /^skip\.?$/i.test(text) ? 'skip' : text.slice(0, 1500)
}

// --- one session's turns -----------------------------------------------------------

/** When the session last wrote to the board, last asked to, and last finished a turn; and what it last posted. */
type Turns = { posted?: number; asked?: number; settled?: number; last?: string }

/**
 * In the temp directory, which agents' sandboxes let commands write (Codex's
 * doesn't allow ~/.config): a marker only has to last a few turns, and the
 * system clears it with the rest of its temp files. `XDG_RUNTIME_DIR`, where
 * there is one, is the user's own.
 */
const turnsDir = () => join(process.env.XDG_RUNTIME_DIR || tmpdir(), `vboard-turns-${process.getuid?.() ?? 'user'}`)
const turnsFile = (session: string) => join(turnsDir(), `${session.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)

function readTurns(session: string): Turns {
  try {
    return JSON.parse(readFileSync(turnsFile(session), 'utf8')) as Turns
  } catch {
    return {}
  }
}

/** The marker directory, only if it's ours: in a shared /tmp, someone else could have made it first. */
function ownTurnsDir(): string {
  const dir = turnsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { uid, mode } = statSync(dir)
  if (process.getuid && uid !== process.getuid()) throw new Error(`${dir} belongs to someone else`)
  if ((mode & 0o077) !== 0) chmodSync(dir, 0o700)
  return dir
}

function writeTurns(session: string, turns: Turns) {
  ownTurnsDir()
  writeFileSync(turnsFile(session), JSON.stringify(turns))
}

/** Where a background post that failed says why: nobody is waiting on it. Best effort. */
export function logHook(line: string) {
  try {
    appendFileSync(join(ownTurnsDir(), 'hooks.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/** A write to the board from an agent session: this turn needs no reminder. Best effort: the write already happened. */
export function markPosted(session: string, now = Date.now()) {
  try {
    writeTurns(session, { ...readTurns(session), posted: now })
  } catch {}
}

/**
 * A reply with a `Board update:` line: the text to post, once (null for
 * `skip`, or for the one already posted). Either way, the turn is accounted
 * for; at the turn's end (`ending`), it's also over.
 */
export function takeUpdate(session: string, reply: string, ending: boolean, now = Date.now()): { found: boolean; post: string | null } {
  const update = boardUpdate(reply)
  if (update === null) return { found: false, post: null }
  const turns = readTurns(session)
  const post = update === 'skip' || update === turns.last ? null : update
  writeTurns(session, { ...turns, posted: now, ...(ending ? { settled: now } : {}), ...(post ? { last: post } : {}) })
  return { found: true, post }
}

/**
 * The turn-end decision: let the agent stop, or ask it once to update the
 * board. It stops freely when it wrote to the board since its last turn
 * ended, when it was already asked this turn, or when the agent says a hook
 * made it continue (`continuing`), so it can never loop.
 */
export function decideStop(session: string, continuing: boolean, now = Date.now()): 'stop' | 'ask' {
  const turns = readTurns(session)
  const since = turns.settled ?? 0
  if (continuing || (turns.posted ?? 0) > since || (turns.asked ?? 0) > since) {
    writeTurns(session, { ...turns, settled: now })
    return 'stop'
  }
  writeTurns(session, { ...turns, asked: now })
  return 'ask'
}

/** What the agent is asked. It answers in its reply: there's nothing to run. */
export const REMINDER = [
  "You didn't update the team's board (vboard) this turn.",
  `Finish with one last line, starting with "${UPDATE_LINE}", that sums up for teammates what you did and what's next in 1–3 sentences.`,
  `If there's nothing worth sharing (a quick question, no changes), make it "${UPDATE_LINE} skip".`,
  "Don't run any command for it, and don't include the prompt, long output, or secrets.",
].join(' ')

// --- where an update goes ----------------------------------------------------------

const git = (cwd: string, ...args: string[]) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** `basehub-ai/vboard` from `git@github.com:basehub-ai/vboard.git` or `https://github.com/basehub-ai/vboard`. */
export function repoName(remote: string): string | null {
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return match ? match[1]! : null
}

/** The work this checkout is on: its repo and branch, which name its thread. */
export function workOf(cwd: string): { repo: string; branch: string; key: string } {
  const root = git(cwd, 'rev-parse', '--show-toplevel') || cwd
  const repo = repoName(git(root, 'remote', 'get-url', 'origin')) ?? basename(root)
  // `symbolic-ref` also names the branch of a repo with no commits yet.
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD') || git(root, 'rev-parse', '--abbrev-ref', 'HEAD') || 'no-branch'
  // Label filters split values on `|`, which a branch name may hold.
  return { repo, branch, key: `${repo}@${branch}`.replace(/\|/g, '%7C').slice(0, 256) }
}

/**
 * The work thread root's stable ID, so two agents starting it at once make one.
 * Hashed: a long branch name would push the principal and key past the ID limit.
 */
export const workRootId = (principal: string, key: string) =>
  `work:${createHash('sha256').update(`${principal}\0${key}`).digest('base64url').slice(0, 32)}`
