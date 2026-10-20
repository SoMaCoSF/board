// The board's own commands: what `vb` does through a client, wherever it runs. The CLI
// gives them the terminal and your files; an agent's `vb` tool gives them its board
// client and its sandbox. Commands about this machine (link, hooks, serve, inspect)
// stay in main.ts.
import { parseArgs } from 'node:util'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import { FILTER_FLAGS, withMentions } from '../api/tail.ts'
import { BoardError, type BoardClient, type Filters } from '../client/client.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { ATTACHMENT_BYTES_MAX, type Attachment, AttachmentId } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import { actorName, formatAccess, formatEvent, formatNotification, formatSchedule, formatSourceRead, formatStuck, formatThreadSummaries, formatThreads, reactionNames, who } from './format.ts'

export const HELP = `vboard ${VERSION}: a message board you mount in one route

usage: vboard <command> [options]      (also installed as \`vb\`)

  whoami                                   who am I, on which board, with which token, and what I can do
  link <url>                               link this project to a board (.vboard/config.json)
  use <url>                                save the default board

  channels                                 channels, grouped by path prefix
  actors                                   actors and their handles
  identity                                 your linked Slack and GitHub accounts
  identity link <key> [--code] [--no-wait] link your account on sync entry <key> (e.g. slack): sign in, or post a code from it
  identity unlink <account>                unlink one, by handle or actor ID

  read [channel] [filters] [--limit N]     the latest threads, one each: root, replies, latest reply
                                           (no channel: every channel)
  read <id>                                one thread, every message (filters: the root and the replies that match)

  post <channel|id> ["<text>"] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--id <key>]
                                           a new thread in a channel, or with an id, a reply in its thread
  reply <id> ["<text>"] [--attach <file>]... [--id <key>] [--no-sync]
  schedule <channel|id> ["<text>"] (--in 1d | --at <time> | --every 30m) [--until <time> | --for 24h | --times N]
           [--label k=v]... [--attach <file>]... [--no-sync]
                                           post later, as you: once, or repeating until a stop or until canceled
  schedules [id] [--by <handle>] [--channel <c>] [--all]
                                           pending schedules (a thread's, with an id); --all adds done and canceled
  schedule cancel <schedule>               stop one, e.g. schedule cancel s12 (yours, or with manage)
  edit <id> "<text>"
  delete <id>
  react <id> <emoji> [--remove]
  label <id> k=v... [--unset k]...
  subscribe <id>                           follow the thread: what's new in it reaches you
  unsubscribe <id>                         stop following it, until you subscribe again
  notifications                            your new notifications, as a declared agent; marks them read
  typing <id> [status]                     show typing in the thread's synced platform threads (marks WhatsApp read);
                                           Slack shows the status, if given, instead of "Typing…"
  sync <id> <target>                       attach the thread to e.g. slack:#incidents, backfilling it
  inbox <key> [channel] [--limit N]        raw platform events, for debugging sync
  stuck                                    events that failed 10 times and stopped their thread (full access only)
  stuck retry|skip <event>                 retry one with a fresh 10 tries, or skip it so its thread goes on,
                                           e.g. stuck retry inbox:slack:C0123#55
  sources                                  the board's sources (its sync entries: slack, github, …)
  sources <key> read <channel|thread|link> [--limit N]
                                           read a source's channel, thread, or message link without syncing it,
                                           e.g. sources slack read '#general', or a Slack permalink (full access only)
  download <attachment> [path]             save an attachment (its name, here, by default; - for stdout)

  hooks [install|uninstall|status] [claude|codex|cursor|pi]...
                                           after a turn that didn't update the board, remind the agent to (linked projects only)

  tail [channel] [filters] [--all]         live, until Ctrl-C
  wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit (124 on timeout)

  inspect [--port N] [--no-open]           the board in your browser, as you: read, post, react (local only)
  serve [--port N] [--dir <dir>] [--no-inspect] [--no-open]
                                           run a board on this machine (127.0.0.1:4100, no sync), link this
                                           project to it, and open the inspector; its log lives in .vboard/,
                                           and you're local:user:<your OS user> (or --handle)

filters:  --re <id>  --by <handle>  --from <source>  --label k[=v|w]  --text <words>  --mentions [@handle]  --after <id>
          labels match a message or its thread's root; repeated flags all must match
global:   --url <url>  --as <profile>  --avatar <url>  --human  --handle <h>  --json
json:     one object per line (JSONL): { message, replies, last } for read <channel>, a message for read <id>
text:     pass "-" to read it from stdin; it may be left out when you --attach
env:      VBOARD_URL  VBOARD_TOKEN  VBOARD_AS  VBOARD_AVATAR  VBOARD_HANDLE`

/** The help's lines for `commands` only, with the filters, in the help's own order and words. */
export function helpFor(commands: readonly string[]): string {
  const lines = HELP.split('\n')
  const kept: string[] = []
  let keep = false
  for (const line of lines) {
    const command = /^ {2}([a-z]+)/.exec(line)?.[1]
    if (command !== undefined) keep = commands.includes(command)
    else if (!/^ {3,}/.test(line)) keep = false
    if (keep) kept.push(line)
  }
  const filters = lines.filter((line) => line.startsWith('filters:') || line.startsWith('          labels'))
  return [...kept, '', ...filters].join('\n')
}

export class UsageError extends Error {}

/** Every flag `vb` takes. The CLI parses its arguments with them, and so does an agent's `vb` tool. */
export const OPTIONS = {
  ...FILTER_FLAGS,
  url: { type: 'string' },
  as: { type: 'string' },
  avatar: { type: 'string' },
  human: { type: 'boolean' },
  handle: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  unset: { type: 'string', multiple: true },
  id: { type: 'string' },
  'no-sync': { type: 'boolean' },
  sync: { type: 'string', multiple: true },
  attach: { type: 'string', multiple: true },
  channel: { type: 'string' },
  agent: { type: 'string' },
  remove: { type: 'boolean' },
  after: { type: 'string' },
  limit: { type: 'string' },
  all: { type: 'boolean' },
  timeout: { type: 'string' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  'no-inspect': { type: 'boolean' },
  dir: { type: 'string' },
  code: { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  in: { type: 'string' },
  at: { type: 'string' },
  every: { type: 'string' },
  until: { type: 'string' },
  for: { type: 'string' },
  times: { type: 'string' },
} as const

// No argument can hold a NUL, so a marked one can't be anything else.
const MARK = '\0'

/**
 * Attachment IDs are base64url, so boards minted some that start with `-`,
 * which `parseArgs` reads as a flag. Where `download` takes its ID, a token
 * shaped like one is the ID: this marks it to parse as a positional.
 */
function markAttachmentId(args: string[]): string[] {
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') positionals.push(arg)
    else if (positionals.length === 1 && positionals[0] === 'download' && AttachmentId.safeParse(arg).success)
      return [...args.slice(0, i), `${MARK}${arg}`, ...args.slice(i + 1)]
    else if (!arg.includes('=') && OPTIONS[arg.slice(2) as keyof typeof OPTIONS]?.type === 'string') i++
  }
  return args
}

/** Commands that are gone, and what to run instead. Their flags don't matter: an old hook's `vb update --skip` gets this too. */
const REMOVED: Record<string, string> = {
  update: "`vb update` is gone: reply in the thread you're working in (vb reply <id>), or post where it fits (vb post <channel>)",
}

/** The command word: the first argument that isn't a flag or a string flag's value. */
function commandWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') return args[i + 1]
    if (!arg.startsWith('-') || arg === '-') return arg
    if (!arg.includes('=') && OPTIONS[arg.slice(2) as keyof typeof OPTIONS]?.type === 'string') i++
  }
  return undefined
}

/**
 * Parses `vb`'s arguments: `@handle` after `--mentions` and all. A removed command throws
 * what to run instead, whatever its flags, and an unknown option says how to pass text that starts with -.
 */
export function parse(argv: string[]) {
  const args = withMentions(argv)
  const removed = REMOVED[commandWord(args) ?? '']
  if (removed) throw new UsageError(removed)
  let parsed
  try {
    parsed = parseArgs({ args: markAttachmentId(args), allowPositionals: true, options: OPTIONS })
  } catch (error) {
    const unknown = (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && /'([^']+)'/.exec((error as Error).message)?.[1]
    if (unknown) throw new UsageError(`unknown option: ${unknown} (run \`vboard help\`; text starting with - goes after --, as in -- "${unknown}")`)
    throw error
  }
  return { values: parsed.values, positionals: parsed.positionals.map((arg) => (arg.startsWith(MARK) ? arg.slice(MARK.length) : arg)) }
}

export type Flags = ReturnType<typeof parse>['values']

/** What a command reads and writes besides the board. */
export type CommandIO = {
  /** The board, made when a command first needs it, so a usage error comes first. */
  client(): BoardClient
  out(text: string): void
  err(text: string): void
  /** Bytes as they are, for `download <id> -`. */
  write(data: Uint8Array): void
  /** What `-` reads as text. */
  stdin(): Promise<string>
  /** Where `--attach` and `download` find and put files, or null where there are none. */
  files: CommandFiles | null
  /** Ends `tail` and `wait` early. */
  signal?: AbortSignal
  /** A write landed: the turn-end hook counts it as this turn's board update. */
  wrote?(): void
}

export type CommandFiles = {
  /** A file's size, or null when there's no file at `path`. */
  stat(path: string): Promise<{ size: number } | null>
  read(path: string): Promise<Uint8Array<ArrayBuffer>>
  write(path: string, data: Uint8Array): Promise<void>
  basename(path: string): string
}

/** The commands here, which `runCommand` runs. */
export const BOARD_COMMANDS = [
  'whoami', 'channels', 'actors', 'read', 'post', 'reply', 'schedule', 'schedules', 'edit', 'delete', 'react', 'label',
  'subscribe', 'unsubscribe', 'notifications', 'typing', 'sync', 'download', 'inbox', 'stuck', 'sources', 'tail', 'wait',
] as const

export function messageId(value: string | undefined, what = 'message id'): number {
  const id = Number(value?.replace(/^#/, ''))
  if (!value || !Number.isInteger(id) || id <= 0) throw new UsageError(`expected a ${what}, got: ${value ?? '(nothing)'}`)
  return id
}

export function labelPairs(values: string[] | undefined): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const value of values ?? []) {
    const at = value.indexOf('=')
    if (at <= 0) throw new UsageError(`labels look like key=value, got: ${value}`)
    pairs[value.slice(0, at)] = value.slice(at + 1)
  }
  return pairs
}

export async function text(io: CommandIO, value: string | undefined): Promise<string> {
  if (value === undefined) throw new UsageError('missing message text')
  if (value !== '-') return value
  return (await io.stdin()).replace(/\n$/, '')
}

/** Uploads each `--attach` file, checking them all before sending any. */
export async function attachments(io: CommandIO, flags: Flags, board: BoardClient): Promise<Attachment[]> {
  const paths = flags.attach ?? []
  if (paths.length === 0) return []
  const files = io.files
  if (!files) throw new UsageError('there are no files here to attach')
  for (const path of paths) {
    const info = await files.stat(path)
    if (!info) throw new UsageError(`no such file: ${path}`)
    if (info.size > ATTACHMENT_BYTES_MAX) throw new UsageError(`${path} is over ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be`)
  }
  const uploaded: Attachment[] = []
  for (const path of paths) uploaded.push(await board.upload({ data: await files.read(path), name: files.basename(path) }))
  return uploaded
}

/** `s12` or `12`. */
function scheduleId(value: string | undefined): number {
  const id = Number(value?.replace(/^s/i, ''))
  if (!value || !Number.isInteger(id) || id <= 0) throw new UsageError(`expected a schedule id like s12, got: ${value ?? '(nothing)'}`)
  return id
}

/** A time flag: anything `Date` reads, as ISO. */
function instant(flag: string, value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) throw new UsageError(`--${flag} takes a time like 2026-10-08T09:00:00Z, got: ${value}`)
  return time.toISOString()
}

export function filters(flags: Flags, channel?: string): Filters & { after?: number } {
  return {
    ...(channel ? { channel } : {}),
    ...(flags.re ? { re: messageId(flags.re) } : {}),
    ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
    ...(flags.mentions ? { mentions: flags.mentions.replace(/^@/, '') } : {}),
    ...(flags.label?.length ? { label: flags.label } : {}),
    ...(flags.from ? { from: flags.from } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(flags.after !== undefined ? { after: Number(flags.after) } : {}),
  }
}

/** A write went through, but some handles in it matched no one: they stayed plain text. */
function warnUnknownMentions(io: CommandIO, handles: string[] | undefined) {
  if (!handles?.length) return
  const names = handles.map((handle) => `@${handle}`)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  const one = names.length === 1
  io.err(`warning: ${list} ${one ? 'matches' : 'match'} no one on the board, so ${one ? 'it stays' : 'they stay'} plain text and ${one ? 'notifies' : 'notify'} no one`)
}

/** Runs one of `BOARD_COMMANDS`; null when `command` isn't one. */
export async function runCommand(command: string, args: string[], flags: Flags, io: CommandIO): Promise<number | null> {
  const { out } = io
  const printJson = (value: unknown) => out(JSON.stringify(value))
  const printMessage = (message: MessageView) => (flags.json ? printJson(message) : out(String(message.id)))
  const printEvent = (event: BoardEventView) => (flags.json ? printJson(event) : out(formatEvent(event)))
  const client = io.client
  const wrote = () => io.wrote?.()

  switch (command) {
    case 'whoami': {
      const board = client()
      const me = await board.me()
      const source = await board.source()
      if (flags.json) {
        printJson({ ...me, board: board.url, source })
        return 0
      }
      out(`${who(me)} (${me.actor})`)
      const rows: [string, string][] = [['board', board.url]]
      if (source) rows.push(['source', source])
      if (me.expiresAt) {
        const minutes = Math.max(0, Math.round((Date.parse(me.expiresAt) - Date.now()) / 60_000))
        rows.push(['token', `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`])
      }
      if (me.session) rows.push(['session', me.session])
      // Full access says nothing; anything less says what it is, one pattern a row.
      ;(me.can === undefined ? [] : formatAccess(me.can)).forEach((line, index) => rows.push([index === 0 ? 'can' : '', line]))
      const width = Math.max(...rows.map(([subject]) => subject.length))
      for (const [subject, value] of rows) out(`${subject.padEnd(width)}  ${value}`)
      return 0
    }

    case 'channels': {
      const channels = await client().channels()
      if (flags.json) return channels.forEach(printJson), 0
      if (channels.length === 0) return out('no channels yet'), 0
      let group = ''
      for (const channel of channels) {
        const prefix = channel.path.includes('/') ? channel.path.slice(0, channel.path.lastIndexOf('/') + 1) : ''
        if (prefix !== group) {
          if (prefix) out(prefix)
          group = prefix
        }
        out(`${prefix ? '  ' : ''}${channel.path}  ${channel.threads} threads · ${channel.messages} messages · last #${channel.lastIndex}`)
      }
      return 0
    }

    case 'actors': {
      const actors = await client().actors()
      if (flags.json) return actors.forEach(printJson), 0
      for (const actor of actors) out(`@${actor.handle}  ${actor.name}  ${actor.id}${actor.person ? `  → @${actor.person.handle}` : ''}`)
      return 0
    }

    case 'read': {
      const target = args[0]
      const board = client()
      if (target && /^#?\d+$/.test(target)) {
        const thread = await board.thread(messageId(target))
        // With filters, the root and only the replies that match them.
        const narrowed = Object.keys(filters(flags)).length > 0
        const replies = narrowed
          ? (await board.messages({ ...filters(flags), re: thread.message.id, limit: 500 })).messages.filter((m) => m.re !== null)
          : thread.replies
        if (flags.json) return [thread.message, ...replies].forEach(printJson), 0
        // Reactions name people who may not have written here: look up the ones that show.
        const authors = new Set([thread.message, ...replies].map((m) => m.by.actor))
        const unnamed = reactionNames([thread.message, ...replies]).filter((id) => !authors.has(id))
        const known = unnamed.length
          ? new Map((await board.actors().catch(() => [])).filter((a) => unnamed.includes(a.id)).map((a) => [a.id, actorName(a)]))
          : new Map<string, string>()
        out(formatThreads([thread.message, ...replies], known))
        if (!narrowed) for (const schedule of thread.schedules ?? []) out(formatSchedule(schedule, { pad: '  ' }))
        return 0
      }
      const query = { ...filters(flags, target), ...(flags.limit ? { limit: Number(flags.limit) } : {}) }
      // A board older than this CLI answers /threads with its discovery document, or a 404 under a basePath.
      const old = new Error("this board can't list threads: update vboard where the board is deployed")
      const page = await board.threads(query).catch((error: unknown) => {
        throw error instanceof BoardError && error.status === 404 ? old : error
      })
      if (!Array.isArray((page as { threads?: unknown }).threads)) throw old
      // Nothing in a channel that doesn't exist is a typo, not an empty channel.
      if (!page.threads.length && target && !(await board.channels()).some((c) => c.path === target || c.path.startsWith(target.replace(/\/?$/, '/'))))
        throw new Error(`no channel ${target}: vboard channels lists them`)
      if (flags.json) return page.threads.forEach(printJson), 0
      const count = `${page.threads.length} ${page.threads.length === 1 ? 'thread' : 'threads'}`
      out(`${target ?? 'all channels'} · ${count} · cursor ${page.cursor}${page.threads.length ? '\n' : ''}`)
      if (page.threads.length) out(formatThreadSummaries(page.threads, { channel: !target || target.endsWith('/') }))
      return 0
    }

    case 'post': {
      const [target, body] = args
      if (!target) throw new UsageError('usage: vboard post <channel|id> "<text>"')
      const re = /^#?\d+$/.test(target) ? messageId(target) : undefined
      if (re !== undefined && flags.sync?.length) throw new UsageError('--sync attaches whole threads: post to a channel, or use vb sync <id> <target>')
      if (flags.sync?.length && flags['no-sync']) throw new UsageError('--sync and --no-sync contradict each other')
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(io, body)
      const files = await attachments(io, flags, board)
      const options = {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      }
      const message = re === undefined
        ? await board.post(target, { ...options, ...(flags.sync?.length ? { sync: flags.sync } : {}) })
        : await board.reply(re, options)
      wrote()
      warnUnknownMentions(io, message.unknownMentions)
      printMessage(message)
      return 0
    }

    case 'reply': {
      const id = messageId(args[0])
      const board = client()
      const content = args[1] === undefined && flags.attach?.length ? '' : await text(io, args[1])
      const files = await attachments(io, flags, board)
      const message = await board.reply(id, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      })
      wrote()
      warnUnknownMentions(io, message.unknownMentions)
      printMessage(message)
      return 0
    }

    case 'schedule': {
      if (args[0] === 'cancel' && args.length === 2) {
        const { schedule, canceled } = await client().cancelSchedule(scheduleId(args[1]))
        if (flags.json) printJson(schedule)
        else out(canceled ? `canceled s${schedule.id}` : `s${schedule.id} is already ${schedule.state}`)
        return 0
      }
      const [target, body] = args
      if (!target) throw new UsageError('usage: vboard schedule <channel|id> "<text>" (--in 1d | --at <time> | --every 30m)')
      if (!flags.in && !flags.at && !flags.every) throw new UsageError('say when: --in 1d, --at <time>, or --every 30m')
      if (flags.sync?.length) throw new UsageError('a schedule posts where you point it: --sync is for post')
      const times = flags.times === undefined ? undefined : Number(flags.times)
      if (times !== undefined && !(Number.isInteger(times) && times > 0)) throw new UsageError(`--times takes a count, got: ${flags.times}`)
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(io, body)
      const files = await attachments(io, flags, board)
      const where = /^#?\d+$/.test(target) ? messageId(target) : target
      const schedule = await board.schedule(where, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.in ? { in: flags.in } : {}),
        ...(flags.at ? { at: instant('at', flags.at) } : {}),
        ...(flags.every ? { every: flags.every } : {}),
        ...(flags.until ? { until: instant('until', flags.until) } : {}),
        ...(flags.for ? { for: flags.for } : {}),
        ...(times !== undefined ? { times } : {}),
      })
      wrote()
      warnUnknownMentions(io, schedule.unknownMentions)
      if (flags.json) printJson(schedule)
      else out(formatSchedule(schedule))
      return 0
    }

    case 'schedules': {
      const list = await client().schedules({
        ...(args[0] ? { re: messageId(args[0]) } : {}),
        ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
        ...(flags.channel ? { channel: flags.channel } : {}),
        ...(flags.all ? { all: true } : {}),
      })
      if (flags.json) return list.forEach(printJson), 0
      if (list.length === 0) return out(flags.all ? 'no schedules' : 'no pending schedules'), 0
      out(list.map((schedule) => formatSchedule(schedule)).join('\n'))
      return 0
    }

    case 'edit': {
      const { unknownMentions } = await client().edit(messageId(args[0]), await text(io, args[1]))
      warnUnknownMentions(io, unknownMentions)
      return 0
    }

    case 'delete': {
      await client().delete(messageId(args[0]))
      return 0
    }

    case 'react': {
      const id = messageId(args[0])
      if (!args[1]) throw new UsageError('usage: vboard react <id> <emoji> [--remove]')
      let emoji: string
      try {
        emoji = normalizeEmoji(args[1])
      } catch (error) {
        throw new UsageError((error as Error).message)
      }
      await client().react(id, emoji, flags.remove ? { remove: true } : {})
      return 0
    }

    case 'label': {
      const id = messageId(args[0])
      const set = labelPairs(args.slice(1))
      const unset = flags.unset ?? []
      if (Object.keys(set).length === 0 && unset.length === 0)
        throw new UsageError('usage: vboard label <id> k=v... [--unset k]...')
      await client().label(id, { set, unset })
      return 0
    }

    case 'subscribe':
    case 'unsubscribe': {
      const id = messageId(args[0])
      const board = client()
      const { root, subscribed } = command === 'subscribe' ? await board.subscribe(id) : await board.unsubscribe(id)
      if (flags.json) printJson({ root, subscribed })
      else out(subscribed ? `subscribed to #${root}` : `unsubscribed from #${root}`)
      return 0
    }

    case 'notifications': {
      const board = client()
      const list = await board.notifications()
      if (flags.json) list.forEach(printJson)
      else out(list.length === 0 ? 'no new notifications' : list.map((n) => formatNotification(n)).join('\n'))
      if (list.length > 0) await board.readNotifications(list.at(-1)!.id)
      return 0
    }

    case 'typing': {
      const id = messageId(args[0])
      const status = args.slice(1).join(' ').trim()
      const targets = await client().typing(id, status || undefined)
      if (flags.json) printJson({ targets })
      return 0
    }

    case 'sync': {
      const id = messageId(args[0])
      if (!args[1]) throw new UsageError('usage: vboard sync <id> <target>   (e.g. slack:#incidents)')
      const result = await client().sync(id, args[1])
      if (flags.json) printJson(result)
      else out(result.attached ? `synced with ${result.target}` : `already synced with ${result.target}`)
      return 0
    }

    case 'download': {
      const id = args[0]
      if (!id) throw new UsageError('usage: vboard download <attachment> [path]   (the id `vb read` shows on a file line)')
      const response = await client().download(id)
      const data = new Uint8Array(await response.arrayBuffer())
      if (args[1] === '-') return io.write(data), 0
      if (!io.files) throw new UsageError('there are no files here to save it to: use `download <attachment> -`')
      const disposition = response.headers.get('content-disposition') ?? ''
      const named = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      const path = args[1] ?? io.files.basename(named ? decodeURIComponent(named) : id)
      await io.files.write(path, data)
      out(path)
      return 0
    }

    case 'inbox': {
      const key = args[0]
      if (!key) throw new UsageError('usage: vboard inbox <key> [channel] [--limit N]')
      const events = await client().inbox(key, {
        ...(args[1] ? { channel: args[1] } : {}),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return events.forEach(printJson), 0
      if (events.length === 0) return out('no events'), 0
      for (const entry of events) {
        const event = entry.event as { kind: string; thread: string; text?: string; type?: string; emoji?: string; author?: { handle: string } }
        const detail = event.text ?? event.type ?? event.emoji ?? ''
        out(`${entry.createdAt}  ${entry.channel}  ${event.kind}  ${event.author?.handle ?? ''}  ${detail.split('\n')[0]}`)
      }
      return 0
    }

    case 'stuck': {
      const [action, ref] = args
      if (action === undefined) {
        const list = await client().stuck()
        if (flags.json) return list.forEach(printJson), 0
        if (list.length === 0) return out('nothing is stuck'), 0
        out(list.map((event) => formatStuck(event)).join('\n'))
        return 0
      }
      const at = ref?.lastIndexOf('#') ?? -1
      const index = ref === undefined ? NaN : Number(ref.slice(at + 1))
      if ((action !== 'retry' && action !== 'skip') || at <= 0 || !Number.isInteger(index) || index < 1 || args.length > 2)
        throw new UsageError('usage: vboard stuck [retry|skip <session>#<index>], e.g. stuck retry board#812')
      const { redriven } = await client().redrive(ref!.slice(0, at), index, action)
      if (flags.json) printJson({ redriven })
      else out(redriven ? `${action === 'retry' ? 'retrying' : 'skipped'} ${ref}` : `${ref} isn't stuck`)
      return 0
    }

    case 'sources': {
      const [key, sub, target] = args
      if (!key) {
        const { sync } = await client().discovery()
        if (flags.json) return sync.forEach(printJson), 0
        if (sync.length === 0) return out('no sources: this board has no sync configured'), 0
        for (const entry of sync) out(`${entry.key}  ${entry.platform}`)
        return 0
      }
      if (sub !== 'read' || !target) throw new UsageError('usage: vboard sources <key> read <channel|thread|link> [--limit N]')
      const read = await client().readSource(key, target, flags.limit ? { limit: Number(flags.limit) } : {})
      // A board older than this CLI answers an unknown path with its discovery document.
      if (!Array.isArray((read as { messages?: unknown }).messages))
        throw new Error("this board can't read sources yet: update vboard where the board is deployed")
      if (flags.json) return printJson(read), 0
      return out(formatSourceRead(key, read)), 0
    }

    case 'tail': {
      for await (const event of client().events(
        { ...filters(flags, args[0]), ...(flags.all ? { all: true } : {}) },
        io.signal ? { signal: io.signal } : {},
      ))
        printEvent(event)
      return 0
    }

    case 'wait': {
      const event = await client().wait(filters(flags, args[0]), {
        timeout: flags.timeout ?? '30m',
        ...(io.signal ? { signal: io.signal } : {}),
      })
      if (!event) {
        if (!io.signal?.aborted) io.err('timed out')
        return 124
      }
      printEvent(event)
      return 0
    }
  }
  return null
}
