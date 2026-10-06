#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import { FILTER_FLAGS, withMentions } from '../api/tail.ts'
import { BoardError, type Filters, type ProfileOption } from '../client/client.ts'
import { configDir, createClient, detectAgent, projectDir, projectUrl } from '../client/node.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { ATTACHMENT_BYTES_MAX, type Attachment } from '../contract/schemas.ts'
import { startInspector } from '../inspect/server.ts'
import { VERSION } from '../version.ts'
import { formatEvent, formatThreads, who } from './format.ts'
import {
  AGENTS,
  decideStop,
  installedHook,
  installHook,
  logHook,
  markPosted,
  REMINDER,
  takeUpdate,
  uninstallHook,
  workOf,
  workRootId,
  type HookAgent,
} from './hooks.ts'

const HELP = `vboard ${VERSION}: a message board you mount in one route

usage: vboard <command> [options]      (also installed as \`vb\`)

  whoami                                   who am I, on which board, and when my token expires
  link <url>                               link this project to a board (.vboard/config.json)
  use <url>                                save the default board

  channels                                 channels, grouped by path prefix
  actors                                   actors and their handles

  read <channel> [filters] [--limit N]     threads in a channel, newest last (no channel: every channel)
  read <id>                                one thread

  post <channel> ["<text>"] [--label k=v]... [--attach <file>]... [--sync <target>]... [--no-sync] [--id <key>]
  reply <id> ["<text>"] [--attach <file>]... [--id <key>] [--no-sync]
  edit <id> "<text>"
  delete <id>
  react <id> <emoji> [--remove]
  label <id> k=v... [--unset k]...
  typing <id>                              show typing in the thread's synced platform threads (marks WhatsApp read)
  sync <id> <target>                       attach the thread to e.g. slack:#incidents, backfilling it
  inbox <key> [channel] [--limit N]        raw platform events, for debugging sync
  download <attachment> [path]             save an attachment (its name, here, by default; - for stdout)

  update ["<text>"] [--attach <file>]...   post a summary to this branch's work thread (channel \`work\`)
  hooks [install|uninstall|status] [claude|codex|cursor]...
                                           after a turn that didn't update the board, the agent is asked to (linked projects only)

  tail [channel] [filters] [--all]         live, until Ctrl-C
  wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit (124 on timeout)

  inspect [--port N] [--no-open]           the board in your browser, as you: read, post, react (local only)

filters:  --re <id>  --by <handle>  --from <source>  --label k[=v|w]  --text <words>  --mentions [@handle]  --after <id>
          labels match a message or its thread's root; repeated flags all must match
global:   --url <url>  --as <profile>  --avatar <url>  --human  --handle <h>  --json
text:     pass "-" to read it from stdin; it may be left out when you --attach
env:      VBOARD_URL  VBOARD_TOKEN  VBOARD_AS  VBOARD_AVATAR  VBOARD_HANDLE`

class UsageError extends Error {}

const { values: flags, positionals } = (() => {
  try {
    return parseArgs({
      args: withMentions(process.argv.slice(2)),
      allowPositionals: true,
      options: {
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
      },
    })
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    process.exit(2)
  }
})()

const out = (text: string) => process.stdout.write(`${text}\n`)
const printJson = (value: unknown) => out(JSON.stringify(value))

function messageId(value: string | undefined, what = 'message id'): number {
  const id = Number(value?.replace(/^#/, ''))
  if (!value || !Number.isInteger(id) || id <= 0) throw new UsageError(`expected a ${what}, got: ${value ?? '(nothing)'}`)
  return id
}

function labelPairs(values: string[] | undefined): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const value of values ?? []) {
    const at = value.indexOf('=')
    if (at <= 0) throw new UsageError(`labels look like key=value, got: ${value}`)
    pairs[value.slice(0, at)] = value.slice(at + 1)
  }
  return pairs
}

async function text(value: string | undefined): Promise<string> {
  if (value === undefined) throw new UsageError('missing message text')
  if (value !== '-') return value
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')
}


/** Uploads each `--attach` file, checking them all before sending any. */
async function attachments(board: ReturnType<typeof client>): Promise<Attachment[]> {
  const paths = flags.attach ?? []
  for (const path of paths) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new UsageError(`no such file: ${path}`)
    if (info.size > ATTACHMENT_BYTES_MAX) throw new UsageError(`${path} is over ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be`)
  }
  const uploaded: Attachment[] = []
  for (const path of paths)
    uploaded.push(
      await board.upload({
        data: new Uint8Array(await readFile(path)),
        name: basename(path),
      }),
    )
  return uploaded
}

function filters(channel?: string): Filters & { after?: number } {
  return {
    ...(channel ? { channel } : {}),
    ...(flags.re ? { re: messageId(flags.re) } : {}),
    ...(flags.by ? { by: flags.by } : {}),
    ...(flags.mentions ? { mentions: flags.mentions.replace(/^@/, '') } : {}),
    ...(flags.label?.length ? { label: flags.label } : {}),
    ...(flags.from ? { from: flags.from } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(flags.after !== undefined ? { after: Number(flags.after) } : {}),
  }
}

function client() {
  const profile: ProfileOption | undefined = flags.human
    ? null
    : flags.as
      ? flags.avatar
        ? { name: flags.as, avatar: flags.avatar }
        : flags.as
      : undefined
  return createClient({
    ...(flags.url ? { url: flags.url } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(flags.human ? { session: null } : {}),
    ...(flags.handle ? { handle: flags.handle } : {}),
  })
}

/** The session of the agent running this command, unless it's writing as a person. */
const agentSession = () => (flags.human ? null : (detectAgent()?.session ?? null))

/** A write from an agent session counts as this turn's board update. */
function wrote() {
  const session = agentSession()
  if (session) markPosted(session)
}

const fromNpx = (path: string) => /[\\/]_npx[\\/]/.test(path)

/** The first `vb` on PATH outside npx's cache, which is gone once npx exits. */
function globalVb(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'vb')
    if (existsSync(candidate) && !fromNpx(realpathSync(candidate))) return realpathSync(candidate)
  }
  return null
}

/**
 * How an agent's hook should run this CLI, long after this command exits:
 * `vb` when that's this CLI; under npx, a global `vb` of this version, else
 * this version through npx; otherwise this CLI's full path.
 */
function cliCommand(): { command: string; note?: string } {
  const self = realpathSync(process.argv[1]!)
  const installed = globalVb()
  if (!fromNpx(self)) {
    if (installed === self) return { command: 'vb' }
    const quote = (part: string) => (/^[\w./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)
    return { command: [process.execPath, self].map(quote).join(' ') }
  }
  let version = ''
  try {
    version = installed ? execFileSync(installed, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() : ''
  } catch {}
  if (version === VERSION) return { command: 'vb' }
  return {
    command: `npx -y vboard@${VERSION}`,
    note: `the hook runs vboard ${VERSION} through npx${installed ? ` (your vb is ${version || 'older'})` : ''}; \`npm i -g vboard\` makes it start faster`,
  }
}

/**
 * One thread per person, repo, and branch, in `work` (or `--channel`): every
 * agent's updates on a branch land together. Created on first use; board-only.
 */
async function postUpdate(board: ReturnType<typeof client>, content: string, files: Attachment[] = []) {
  const channel = flags.channel ?? 'work'
  const work = workOf(process.cwd())
  const me = await board.me()
  // The label matches replies too, so a busy branch can push the root past one page: page back to it.
  const find = async () => {
    let before: number | undefined
    for (let page = 0; page < 20; page++) {
      const { messages } = await board.messages({ channel, label: { work: work.key }, limit: 500, ...(before ? { before } : {}) })
      const root = messages.filter((m) => m.re === null && !m.deleted && m.by.principal === me.principal).at(-1)
      if (root || messages.length < 500) return root
      before = messages[0]!.id
    }
    return undefined
  }
  const create = () =>
    board.post(channel, {
      text: `**${work.repo}** · \`${work.branch}\``,
      labels: { work: work.key, repo: work.repo, branch: work.branch },
      noSync: true,
      // One root per person and branch: a second agent creating it at the same moment gets a conflict, not a twin.
      id: workRootId(me.principal, work.key),
    })
  let root = await find()
  if (!root)
    try {
      root = await create()
    } catch (error) {
      if (!(error instanceof BoardError && error.code === 'duplicate_id')) throw error
      root = await find()
    }
  if (!root || root.deleted) throw new BoardError('no_work_thread', `couldn't find or start the work thread for ${work.key}`, 0)
  return board.reply(root.id, { text: content, noSync: true, ...(files.length ? { attachments: files } : {}) })
}

/** Posts an agent's `Board update:` line in a process of its own, so the agent's turn never waits on the board. */
function postInBackground(agent: string, session: string, cwd: string, update: string) {
  const child = spawn(process.execPath, [realpathSync(process.argv[1]!), 'hook', 'post', '--agent', agent, ...(flags.channel ? ['--channel', flags.channel] : [])], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, VBOARD_HOOK_SESSION: session, VBOARD_HOOK_UPDATE: update },
  })
  child.unref()
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function hookAgents(names: string[]): HookAgent[] {
  const known = Object.keys(AGENTS) as HookAgent[]
  for (const name of names)
    if (!known.includes(name as HookAgent)) throw new UsageError(`unknown agent: ${name} (known: ${known.join(', ')})`)
  return names.length ? (names as HookAgent[]) : known
}

function printMessage(message: MessageView) {
  if (flags.json) printJson(message)
  else out(String(message.id))
}

function printEvent(event: BoardEventView) {
  if (flags.json) printJson(event)
  else out(formatEvent(event))
}

/** Best-effort: the URL is printed either way. */
function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  const child = spawn(command!, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function run(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case undefined:
    case 'help':
      out(HELP)
      return 0

    case 'link':
    case 'use': {
      const url = args[0]
      if (!url || args.length !== 1) throw new UsageError(`usage: vboard ${command} <url>`)
      const board = createClient({ url })
      const discovery = await board.discovery()
      const root = command === 'link' ? projectDir() : null
      const directory = root === null ? configDir() : join(root, '.vboard')
      if (root !== null) {
        const path = join(root, '.gitignore')
        const ignore = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return ''
          throw error
        })
        if (!ignore.split(/\r?\n/).some((line) => /^\/?\.vboard\/?$/.test(line)))
          await appendFile(path, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}.vboard/\n`)
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'config.json'), `${JSON.stringify({ url: discovery.url }, null, 2)}\n`, { mode: 0o600 })
      out(root === null ? `using ${discovery.url}` : `linked ${root} to ${discovery.url}`)
      return 0
    }

    case 'whoami': {
      const board = client()
      const me = await board.me()
      if (flags.json) {
        printJson({ ...me, board: board.url })
        return 0
      }
      const name = me.profile !== null ? `${me.name} via ${me.handle.split('/')[0]}` : me.name
      out(`${name} (${me.actor})`)
      out(`board  ${board.url}`)
      if (me.expiresAt) {
        const minutes = Math.max(0, Math.round((Date.parse(me.expiresAt) - Date.now()) / 60_000))
        out(`token  expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`)
      }
      if (me.session) out(`session  ${me.session}`)
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
      for (const actor of actors) out(`@${actor.handle}  ${actor.name}  ${actor.id}`)
      return 0
    }

    case 'read': {
      const target = args[0]
      const filtering = !!(flags.re || flags.by || flags.from || flags.text || flags.mentions || flags.label?.length)
      if (!target && !filtering) throw new UsageError('usage: vboard read <channel|id> [filters], or read [filters] across channels')
      const board = client()
      if (target && /^#?\d+$/.test(target)) {
        const thread = await board.thread(messageId(target))
        if (flags.json) return [thread.message, ...thread.replies].forEach(printJson), 0
        out(formatThreads([thread.message, ...thread.replies]))
        return 0
      }
      const page = await board.messages({
        ...filters(target),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return page.messages.forEach(printJson), 0
      out(`${target ?? 'all channels'} · cursor ${page.cursor}\n`)
      out(page.messages.length ? formatThreads(page.messages) : 'no messages')
      return 0
    }

    case 'post': {
      const [channel, body] = args
      if (!channel) throw new UsageError('usage: vboard post <channel> "<text>"')
      if (flags.sync?.length && flags['no-sync']) throw new UsageError('--sync and --no-sync contradict each other')
      const board = client()
      const content = body === undefined && flags.attach?.length ? '' : await text(body)
      const files = await attachments(board)
      const message = await board.post(channel, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.sync?.length ? { sync: flags.sync } : {}),
      })
      wrote()
      printMessage(message)
      return 0
    }

    case 'reply': {
      const id = messageId(args[0])
      const board = client()
      const content = args[1] === undefined && flags.attach?.length ? '' : await text(args[1])
      const files = await attachments(board)
      const message = await board.reply(id, {
        text: content,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      })
      wrote()
      printMessage(message)
      return 0
    }

    case 'update': {
      const board = client()
      const content = args[0] === undefined && flags.attach?.length ? '' : await text(args[0])
      const message = await postUpdate(board, content, await attachments(board))
      wrote()
      printMessage(message)
      return 0
    }

    case 'hooks': {
      const [action = 'status', ...names] = args
      const agents = hookAgents(names)
      if (action === 'status') {
        for (const agent of agents) out(`${AGENTS[agent].name}: ${installedHook(agent) ?? 'not installed'}`)
        return 0
      }
      if (action === 'uninstall') {
        for (const agent of agents)
          out(`${AGENTS[agent].name}: ${uninstallHook(agent) ? `removed the turn-end hook from ${AGENTS[agent].file()}` : 'not installed'}`)
        return 0
      }
      if (action !== 'install') throw new UsageError(`usage: vboard hooks [install|uninstall|status] [${Object.keys(AGENTS).join('|')}]...`)
      const { command: cli, note } = cliCommand()
      for (const agent of agents) {
        const changed = installHook(agent, cli, flags.channel ? ` --channel ${flags.channel}` : '')
        out(`${AGENTS[agent].name}: ${changed ? `added the turn-end hook to ${AGENTS[agent].file()}` : 'already installed'}`)
        if (agent === 'codex' && changed) out('  approve it once in Codex with /hooks')
      }
      if (note) out(`Note: ${note}.`)
      out('It asks only in projects linked with `vb link <url>` (or with VBOARD_URL set), once per turn that didn\'t update the board.')
      return 0
    }

    // What an agent's hooks run. They must never break the agent's turn: any failure lets it stop.
    case 'hook': {
      const [event] = args
      const agent = flags.agent ?? 'agent'
      if (event === 'post') {
        // The background half of a `Board update:` line: as the agent, in its session.
        try {
          const board = createClient({ ...(flags.url ? { url: flags.url } : {}), profile: agent, session: process.env.VBOARD_HOOK_SESSION ?? null })
          await postUpdate(board, process.env.VBOARD_HOOK_UPDATE ?? '')
        } catch (error) {
          logHook(`${agent}: couldn't post an update: ${(error as Error).message}`)
        }
        return 0
      }
      if (event !== 'stop' && event !== 'response')
        throw new UsageError("usage: vboard hook stop|response --agent <agent>   (run by an agent's hooks)")
      try {
        // Claude Code and Codex send `session_id`, `cwd`, `stop_hook_active`, and the reply; Cursor sends
        // `conversation_id`, `workspace_roots`, and `loop_count`, with the reply in its own `afterAgentResponse` event.
        const payload = JSON.parse(await readStdin()) as {
          session_id?: string
          conversation_id?: string
          cwd?: string
          workspace_roots?: string[]
          stop_hook_active?: boolean
          loop_count?: number
          status?: string
          last_assistant_message?: string
          text?: string
        }
        const session = payload.session_id ?? payload.conversation_id
        const cwd = payload.cwd ?? payload.workspace_roots?.[0]
        if (cwd && existsSync(cwd)) process.chdir(cwd)
        if (!session || !(process.env.VBOARD_URL || projectUrl())) return 0
        const reply = event === 'response' ? payload.text : payload.last_assistant_message
        if (reply) {
          const { found, post } = takeUpdate(session, reply, event === 'stop')
          if (post) postInBackground(agent, session, process.cwd(), post)
          if (found || event === 'response') return 0
        } else if (event === 'response') return 0
        if (payload.status && payload.status !== 'completed') return 0
        const continuing = payload.stop_hook_active === true || (payload.loop_count ?? 0) > 0
        if (decideStop(session, continuing) === 'ask')
          printJson(agent === 'cursor' ? { followup_message: REMINDER } : { decision: 'block', reason: REMINDER })
      } catch {}
      return 0
    }

    case 'edit': {
      await client().edit(messageId(args[0]), await text(args[1]))
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

    case 'typing': {
      const id = messageId(args[0])
      const targets = await client().typing(id)
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
      if (!id) throw new UsageError('usage: vboard download <attachment> [path]   (the id `vb read` shows after 📎)')
      const response = await client().download(id)
      const data = new Uint8Array(await response.arrayBuffer())
      if (args[1] === '-') return process.stdout.write(data), 0
      const disposition = response.headers.get('content-disposition') ?? ''
      const named = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      const path = args[1] ?? basename(named ? decodeURIComponent(named) : id)
      await writeFile(path, data)
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

    case 'tail': {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      for await (const event of client().events(
        { ...filters(args[0]), ...(flags.all ? { all: true } : {}) },
        { signal: controller.signal },
      ))
        printEvent(event)
      return 0
    }

    case 'wait': {
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      const event = await client().wait(filters(args[0]), {
        timeout: flags.timeout ?? '30m',
        signal: controller.signal,
      })
      if (!event) {
        if (!controller.signal.aborted) process.stderr.write('timed out\n')
        return 124
      }
      printEvent(event)
      return 0
    }

    case 'inspect': {
      const port = flags.port === undefined ? undefined : Number(flags.port)
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
        throw new UsageError(`expected a port, got: ${flags.port}`)
      const inspector = await startInspector({ client: client(), ...(port !== undefined ? { port } : {}) })
      out(`inspecting ${inspector.board} as ${who(inspector.me)} at ${inspector.url}  (Ctrl-C to stop)`)
      if (!flags['no-open']) openBrowser(inspector.url)
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      await inspector.close()
      return 0
    }

    default:
      throw new UsageError(`unknown command: ${command} (run \`vboard help\`)`)
  }
}

if (flags.version) {
  out(VERSION)
} else if (flags.help) {
  out(HELP)
} else {
  const [command, ...args] = positionals
  run(command, args).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`error: ${(error as Error).message}\n`)
      process.exit(error instanceof UsageError ? 2 : 1)
    },
  )
}
