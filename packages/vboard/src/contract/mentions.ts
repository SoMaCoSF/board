import { agentActorId } from './schemas.ts'

const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const NAME = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?'
// `@ada` and `@julian/claude`; never part of an email or a longer token.
const MENTION = new RegExp(
  `(?<![\\w@.-])@(${NAME}(?:/${NAME})?)(?!:|[a-z0-9_/-]|\\.(?=[a-z0-9]))`,
  'gi',
)
// `@[slack:T0123:U0456]` names an exact actor.
const EXACT = /(?<![\w@.-])@\[([^\]\s]+)\]/g

/** Blanks out code so mentions inside it never count. */
const proseOnly = (text: string): string =>
  text
    .replace(FENCED_CODE, (match) => ' '.repeat(match.length))
    .replace(INLINE_CODE, (match) => ' '.repeat(match.length))

export type MentionToken =
  | { kind: 'handle'; handle: string }
  | { kind: 'actor'; actor: string }

/** Mentions in prose order, deduplicated. Handles are lowercased. */
export function extractMentions(text: string): MentionToken[] {
  const prose = proseOnly(text)
  const found: { index: number; token: MentionToken; key: string }[] = []
  for (const match of prose.matchAll(EXACT)) {
    const actor = match[1]
    if (actor !== undefined)
      found.push({
        index: match.index,
        token: { kind: 'actor', actor },
        key: `actor:${actor}`,
      })
  }
  for (const match of prose.replace(EXACT, (m) => ' '.repeat(m.length)).matchAll(MENTION)) {
    const handle = match[1]?.toLowerCase()
    if (handle !== undefined)
      found.push({
        index: match.index,
        token: { kind: 'handle', handle },
        key: `handle:${handle}`,
      })
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.index - b.index)
    .filter(({ key }) => !seen.has(key) && seen.add(key))
    .map(({ token }) => token)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Each match of `pattern` in prose, rewritten by `replace` from the original text's
 * match and groups; null keeps it. Code is left alone.
 */
function replaceInProse(text: string, pattern: RegExp, replace: (groups: (string | undefined)[]) => string | null): string {
  const indexed = new RegExp(pattern.source, pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`)
  let out = ''
  let at = 0
  for (const match of proseOnly(text).matchAll(indexed)) {
    // The blanked copy keeps every offset, so the original's groups are at the same indices.
    const groups = match.indices!.map((span) => (span ? text.slice(span[0], span[1]) : undefined))
    out += text.slice(at, match.index) + (replace(groups) ?? groups[0]!)
    at = match.index + match[0].length
  }
  return out + text.slice(at)
}

const AGENT_NAME = '[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?'

/**
 * Platform text addressing the board's agents: `@app +helper`, `@app+helper`, or
 * `@app +helper +reviewer`, where `@app` is one of `forms`, the ways the platform
 * wrote the board's own app. Each declared name becomes `@[vboard:agent:name]`. A
 * name that isn't declared stays as written, and so does the whole mention when none is.
 */
export function addressAgents(text: string, forms: readonly string[], isAgent: (name: string) => boolean): string {
  if (forms.length === 0 || !text.includes('+')) return text
  const app = [...forms].sort((a, b) => b.length - a.length).map(escape).join('|')
  const pattern = new RegExp(`(?<![\\w@.-])(?:${app})((?:[^\\S\\n]*\\+${AGENT_NAME}(?![a-z0-9_-]))+)`, 'gi')
  return replaceInProse(text, pattern, ([, names]) => {
    let addressed = false
    const out = names!.replace(new RegExp(`\\+(${AGENT_NAME})`, 'gi'), (token, name: string) => {
      if (!isAgent(name.toLowerCase())) return token
      addressed = true
      return `@[${agentActorId(name.toLowerCase())}]`
    })
    return addressed ? out.replace(/^[^\S\n]+/, '') : null
  })
}

/**
 * Platform text with each native mention, as the platform wrote it (`form`, like
 * `@Ada Lovelace`), replaced by its exact actor: `@[slack:user:U0456]`. `mentions`
 * lists one entry per mention, in the order they appear, so a form two people share
 * (both display as `@Ada`) resolves by position: its n-th appearance is its n-th entry.
 * When the counts don't line up, those stay as written, never the wrong person.
 */
export function exactMentions(text: string, mentions: readonly { form: string; actor: string }[]): string {
  if (mentions.length === 0) return text
  const byForm = new Map<string, string[]>()
  for (const { form, actor } of mentions) {
    const key = form.toLowerCase()
    byForm.set(key, [...(byForm.get(key) ?? []), actor])
  }
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')
  const pattern = new RegExp(`(?<![\\w@.-])(?:${forms})(?![\\w-])`, 'gi')
  const appearances = new Map<string, number>()
  for (const [form] of proseOnly(text).matchAll(pattern)) appearances.set(form.toLowerCase(), (appearances.get(form.toLowerCase()) ?? 0) + 1)
  const used = new Map<string, number>()
  return replaceInProse(text, pattern, ([form]) => {
    const key = form!.toLowerCase()
    const actors = byForm.get(key)!
    const n = used.get(key) ?? 0
    used.set(key, n + 1)
    if (new Set(actors).size === 1) return `@[${actors[0]}]`
    return appearances.get(key) === actors.length ? `@[${actors[n]}]` : null
  })
}

/** Stored text as people read it: each exact mention, `@[slack:user:U0456]`, as `@handle`. */
export function displayMentions(text: string, mentioned: Readonly<Record<string, { handle: string }>>): string {
  if (!text.includes('@[')) return text
  return replaceMentions(text, (token) => {
    if (token.kind !== 'actor') return null
    const actor = mentioned[token.actor]
    return actor ? `@${actor.handle}` : null
  })
}

/**
 * Rewrites each mention in prose with `replace`, which also gets the mention as
 * written; one it returns null for stays as written.
 * Code is left alone, as in `extractMentions`.
 */
export function replaceMentions(text: string, replace: (token: MentionToken, written: string) => string | null): string {
  const prose = proseOnly(text)
  const found: { index: number; length: number; token: MentionToken }[] = []
  for (const match of prose.matchAll(EXACT))
    found.push({ index: match.index, length: match[0].length, token: { kind: 'actor', actor: match[1]! } })
  for (const match of prose.replace(EXACT, (m) => ' '.repeat(m.length)).matchAll(MENTION))
    found.push({ index: match.index, length: match[0].length, token: { kind: 'handle', handle: match[1]!.toLowerCase() } })
  let out = ''
  let at = 0
  for (const { index, length, token } of found.sort((a, b) => a.index - b.index)) {
    const written = text.slice(index, index + length)
    out += text.slice(at, index) + (replace(token, written) ?? written)
    at = index + length
  }
  return out + text.slice(at)
}
