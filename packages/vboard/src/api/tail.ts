import { z } from 'zod'
import { Filters } from './routes.ts'

/** The filter flags `read`, `tail`, and `wait` share, and that a watcher's `tail` accepts. */
export const FILTER_FLAGS = {
  re: { type: 'string' },
  by: { type: 'string' },
  mentions: { type: 'string' },
  label: { type: 'string', multiple: true },
  from: { type: 'string' },
  text: { type: 'string' },
} as const

/** `--mentions` alone means mentions of me; `--mentions @ada`, mentions of ada. */
export function withMentions(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg !== '--mentions') out.push(arg)
    else if (args[i + 1]?.startsWith('@')) out.push(`--mentions=${args[++i]}`)
    else out.push('--mentions=me')
  }
  return out
}

/** Splits an expression the way a shell would: whitespace separates, quotes group, `\` escapes. */
export function words(expression: string): string[] {
  const out: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < expression.length) word += expression[++i]!
      else word += char
    } else if (/\s/.test(char)) {
      if (word !== null) out.push(word)
      word = null
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === '\\' && i + 1 < expression.length) word = (word ?? '') + expression[++i]!
    else word = (word ?? '') + char
  }
  if (quote) throw new Error(`unterminated ${quote}`)
  if (word !== null) out.push(word)
  return out
}

/** A watcher's tail takes the filters and `--all`, which shows receipts as it does in `vb tail`. */
const TAIL_FLAGS = { ...FILTER_FLAGS, all: { type: 'boolean' } } as const

type TailValues = { re?: string; by?: string; mentions?: string; label?: string[]; from?: string; text?: string; all?: boolean }

/**
 * Parses filter flags as the CLI's parser does (Node's `parseArgs`, strict), written out so a tail
 * parses wherever board() runs, a browser included.
 */
function parseFilterFlags(args: string[]): { values: TailValues; positionals: string[] } {
  const values: Record<string, string | string[] | boolean> = {}
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : null
    const spec = name !== null && Object.hasOwn(TAIL_FLAGS, name) ? TAIL_FLAGS[name as keyof typeof TAIL_FLAGS] : null
    if (!spec) throw new Error(`${name !== null ? `--${name}` : arg.slice(0, 2)} isn't a filter`)
    if (spec.type === 'boolean') {
      if (eq !== -1) throw new Error(`--${name} takes no value`)
      values[name!] = true
      continue
    }
    let value: string
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      const next = args[i + 1]
      // A value that looks like a flag is a forgotten one: `--text=-1` says it's meant.
      if (next === undefined || (next.length > 1 && next.startsWith('-'))) throw new Error(`--${name} needs a value`)
      value = next
      i++
    }
    if ('multiple' in spec) values[name!] = [...((values[name!] as string[] | undefined) ?? []), value]
    else values[name!] = value
  }
  return { values: values as TailValues, positionals }
}

/** A `vb tail` expression, `firehose --label status=needs-agent`, as filters. */
export function parseTail(expression: string): z.output<typeof Filters> {
  return parseWatchTail(expression).filters
}

/** A watcher's `tail`: its filters, and whether `--all` shows it receipts too. */
export function parseWatchTail(expression: string): { filters: z.output<typeof Filters>; all: boolean } {
  const { values, positionals } = parseFilterFlags(withMentions(words(expression)))
  if (positionals.length > 1) throw new Error(`expected one channel, got: ${positionals.join(' ')}`)
  const channel = positionals[0]
  const parsed = Filters.safeParse({
    ...(channel ? { channel } : {}),
    ...(values.re ? { re: values.re.replace(/^#/, '') } : {}),
    ...(values.by ? { by: values.by.replace(/^@/, '') } : {}),
    ...(values.mentions ? { mentions: values.mentions.replace(/^@/, '') } : {}),
    ...(values.label?.length ? { label: values.label } : {}),
    ...(values.from ? { from: values.from } : {}),
    ...(values.text ? { text: values.text } : {}),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${issue?.path.length ? `--${String(issue.path[0])}: ` : ''}${issue?.message ?? 'invalid filters'}`)
  }
  return { filters: parsed.data, all: values.all === true }
}
