#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { BoardEventView, MessageView } from '../api/routes.ts'
import { FILTER_FLAGS, withMentions } from '../api/tail.ts'
import { BoardError, type Filters, type ProfileOption } from '../client/client.ts'
import { configDir, createClient } from '../client/node.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { startInspector } from '../inspect/server.ts'
import { VERSION } from '../version.ts'
import { formatEvent, formatThreads, who } from './format.ts'

const HELP = `vboard ${VERSION}: a message board you mount in one route

usage: vboard <command> [options]      (also installed as \`vb\`)

  whoami                                   who am I, on which board, and when my token expires
  use <url>                                save the default board

  channels                                 channels, grouped by path prefix
  actors                                   actors and their handles

  read <channel> [filters] [--limit N]     threads in a channel, newest last (no channel: every channel)
  read <id>                                one thread

  post <channel> "<text>" [--label k=v]... [--sync <target>]... [--no-sync] [--id <key>]
  reply <id> "<text>" [--id <key>] [--no-sync]
  edit <id> "<text>"
  delete <id>
  react <id> <emoji> [--remove]
  label <id> k=v... [--unset k]...
  sync <id> <target>                       attach the thread to e.g. slack:#incidents, backfilling it
  inbox <key> [channel] [--limit N]        raw platform events, for debugging sync

  tail [channel] [filters] [--all]         live, until Ctrl-C
  wait [channel] [filters] [--timeout 30m] block for the next match, print it, then exit (124 on timeout)

  inspect [--port N] [--no-open]           the board in your browser, as you: read, post, react (local only)

filters:  --re <id>  --by <handle>  --from <source>  --label k[=v|w]  --text <words>  --mentions [@handle]  --after <id>
          labels match a message or its thread's root; repeated flags all must match
global:   --url <url>  --as <profile>  --avatar <url>  --human  --handle <h>  --json
text:     pass "-" to read it from stdin
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

/** The actor directory, fetched only when a reactor hasn't written a message in view. */
async function reactors(board: ReturnType<typeof client>, messages: MessageView[]) {
  const authors = new Set(messages.map((m) => m.by.actor))
  const unnamed = messages.some((m) => Object.values(m.reactions).some((ids) => ids.some((id) => !authors.has(id))))
  return unnamed ? board.actors() : []
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

    case 'use': {
      const url = args[0]
      if (!url) throw new UsageError('usage: vboard use <url>')
      const board = createClient({ url })
      const discovery = await board.discovery()
      await mkdir(configDir(), { recursive: true, mode: 0o700 })
      await writeFile(join(configDir(), 'config.json'), JSON.stringify({ url: discovery.url }, null, 2))
      out(`using ${discovery.url}`)
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
        out(formatThreads([thread.message, ...thread.replies], await reactors(board, [thread.message, ...thread.replies])))
        return 0
      }
      const page = await board.messages({
        ...filters(target),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return page.messages.forEach(printJson), 0
      out(`${target ?? 'all channels'} · cursor ${page.cursor}\n`)
      out(page.messages.length ? formatThreads(page.messages, await reactors(board, page.messages)) : 'no messages')
      return 0
    }

    case 'post': {
      const [channel, body] = args
      if (!channel) throw new UsageError('usage: vboard post <channel> "<text>"')
      if (flags.sync?.length && flags['no-sync']) throw new UsageError('--sync and --no-sync contradict each other')
      const message = await client().post(channel, {
        text: await text(body),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.sync?.length ? { sync: flags.sync } : {}),
      })
      printMessage(message)
      return 0
    }

    case 'reply': {
      const id = messageId(args[0])
      const message = await client().reply(id, {
        text: await text(args[1]),
        ...(flags.id ? { id: flags.id } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      })
      printMessage(message)
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

    case 'sync': {
      const id = messageId(args[0])
      if (!args[1]) throw new UsageError('usage: vboard sync <id> <target>   (e.g. slack:#incidents)')
      const result = await client().sync(id, args[1])
      if (flags.json) printJson(result)
      else out(result.attached ? `synced with ${result.target}` : `already synced with ${result.target}`)
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
