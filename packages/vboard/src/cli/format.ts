import type { BoardEventView, MessageView } from '../api/routes.ts'
import { displayEmoji } from '../contract/emoji.ts'

/** "claude via julian" for a profile, the name otherwise. */
/** "claude via julian" for a profile, the name otherwise. */
export const who = (me: { name: string; handle: string; profile: string | null }): string =>
  me.profile !== null && me.handle.includes('/') ? `${me.name} via ${me.handle.slice(0, me.handle.indexOf('/'))}` : me.name

export function authorName(message: Pick<MessageView, 'author' | 'by'>): string {
  const author = message.author
  if (!author) return message.by.actor
  const slash = author.handle.indexOf('/')
  if (message.by.profile !== null && slash !== -1)
    return `${author.name} via ${author.handle.slice(0, slash)}`
  return author.name
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')

function labels(message: MessageView): string {
  const entries = Object.entries(message.labels)
  return entries.length ? `  [${entries.map(([k, v]) => `${k}=${v}`).join(' ')}]` : ''
}

function reactions(message: MessageView, names: Map<string, string>): string {
  const groups = Object.entries(message.reactions)
  if (groups.length === 0) return ''
  return groups
    .map(([emoji, actors]) => `${displayEmoji(emoji)} ${actors.map((id) => names.get(id) ?? id).join(', ')}`)
    .join('   ')
}

/** One message as a block: header line, indented text, reactions. */
export function formatMessage(message: MessageView, options: { reply?: boolean; names?: Map<string, string> } = {}) {
  const pad = options.reply ? '    ' : '      '
  const head = `${options.reply ? '  ↳ ' : ''}#${message.id}  ${authorName(message)} · ${ago(message.createdAt)}${
    message.editedAt ? ' (edited)' : ''
  }${labels(message)}`
  const body = message.deleted ? `${pad}(message removed)` : indent(message.text, pad)
  const reacted = reactions(message, options.names ?? new Map())
  const undelivered = Object.entries(message.undelivered ?? {}).map(([target, error]) => `${pad}✗ didn't reach ${target}: ${error}`)
  return [head, body, ...(reacted ? [`${pad}${reacted}`] : []), ...undelivered].join('\n')
}

/**
 * Threads in order, each root followed by its replies. `actors` (the board's
 * directory) names reactors who haven't written a message in view.
 */
export function formatThreads(messages: MessageView[], actors: { id: string; name: string }[] = []): string {
  const names = new Map(actors.map((a) => [a.id, a.name]))
  for (const m of messages) names.set(m.by.actor, authorName(m))
  const byRoot = new Map<number, MessageView[]>()
  const roots: MessageView[] = []
  const orphans: MessageView[] = []
  for (const message of messages) {
    if (message.re === null) roots.push(message)
    else (byRoot.get(message.re) ?? byRoot.set(message.re, []).get(message.re)!).push(message)
  }
  const rootIds = new Set(roots.map((r) => r.id))
  for (const [root, replies] of byRoot) if (!rootIds.has(root)) orphans.push(...replies)
  const blocks = roots.map((root) =>
    [formatMessage(root, { names }), ...(byRoot.get(root.id) ?? []).map((r) => formatMessage(r, { reply: true, names }))].join('\n'),
  )
  for (const reply of orphans)
    blocks.push(`(in thread #${reply.re})\n${formatMessage(reply, { reply: true, names })}`)
  return blocks.join('\n\n')
}

/** One line per live event, for `tail` and `wait`. */
export function formatEvent(event: BoardEventView): string {
  const message = event.message
  if (!message) return `#${event.index}  ${event.type}`
  const where = message.re === null ? message.channel : `${message.channel} ↳ #${message.re}`
  const who = authorName(message)
  switch (event.type) {
    case 'message.posted':
      return `#${message.id}  ${where}  ${who}: ${message.text}`
    case 'message.edited':
      return `#${message.id}  ${where}  ${who} (edited): ${message.text}`
    case 'message.deleted':
      return `#${message.id}  ${where}  (message removed)`
    case 'reaction.added':
    case 'reaction.removed':
      return `#${message.id}  ${where}  ${displayEmoji(event.payload.emoji)} ${
        event.type === 'reaction.added' ? 'added' : 'removed'
      } by ${event.actor?.name ?? event.payload.by.actor}`
    case 'labels.changed': {
      const set = Object.entries(event.payload.set).map(([k, v]) => `${k}=${v}`)
      const unset = event.payload.unset.map((k) => `-${k}`)
      return `#${message.id}  ${where}  labels ${[...set, ...unset].join(' ')}${event.actor ? ` by ${event.actor.name}` : ''}`
    }
    case 'message.sync_failed':
      return `#${message.id}  ${where}  ✗ didn't reach ${event.payload.target}: ${event.payload.error}`
    default:
      return `#${event.index}  ${event.type}`
  }
}
