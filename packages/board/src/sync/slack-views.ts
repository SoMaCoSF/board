import { findBlocks } from '../contract/blocks.ts'
import { BUILT_IN_SCHEMAS } from '../contract/data-schemas.ts'
import { checkValue } from '../contract/data-values.ts'

/** One of Slack's layout blocks, as its API takes it. */
export type SlackBlock = { type: string } & Record<string, unknown>

/**
 * How Slack shows a block's data: its layout blocks, the same in plain words for a notification,
 * and the same as markdown, for where the layout can't go.
 */
type View = (data: Record<string, unknown>) => { blocks: SlackBlock[]; text: string; markdown: string }

/** The most text Slack takes across a message's `markdown` blocks. */
const MARKDOWN_MAX = 12_000
/** The most layout blocks Slack takes in a message. */
const BLOCKS_MAX = 50
/** The most notification text Slack takes: an edit over 4,000 characters is refused. */
const TEXT_MAX = 3900

/** How Slack is given text: the text around a block as the markdown it posts, and the notification's as its older mrkdwn. Each as written without one. */
export type SlackText = { markdown?: (markdown: string) => string; mrkdwn?: (markdown: string) => string }

const raw = (text: string) => ({ type: 'raw_text', text: text || ' ' })
/** A cell of formatted text: an emoji, a link, a date. */
const rich = (...elements: Record<string, unknown>[]) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] })
const link = (text: string, url: string) => ({ type: 'link', text, url })
const short = (sha: string) => sha.slice(0, 7)
const firstLine = (text: string) => text.trim().split('\n')[0]!.trim()
const capitalized = (word: string) => word.slice(0, 1).toUpperCase() + word.slice(1)
/** A time as Slack takes one, in seconds, or null when it isn't one a clock reads. */
const secondsOf = (time: string | undefined) => (time === undefined || Number.isNaN(Date.parse(time)) ? null : Math.floor(Date.parse(time) / 1000))
/** Text as markdown shows it as written: what would format it, escaped. */
const literal = (text: string) => text.replace(/[\\`*_~[\]<>]/g, '\\$&')
const linked = (text: string, url: string | undefined) => (url ? `[${literal(text)}](${url})` : literal(text))
/** A time as Vercel writes one: `Nov 12, 2026, 9:30 PM UTC`. */
const UTC = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const written = (seconds: number) => `${UTC.format(seconds * 1000).replace(/\u202f/g, ' ')} UTC`

type Deployment = { project: string; state: string; url?: string; environment?: string; inspectorUrl?: string; projectUrl?: string; updatedAt?: string }

/** The dot Vercel shows beside a deployment's state: the emoji Slack has for it, and the character markdown does. */
const DOT: Record<string, [emoji: string, character: string]> = {
  queued: ['white_circle', '⚪'],
  building: ['large_yellow_circle', '🟡'],
  ready: ['large_green_circle', '🟢'],
  error: ['red_circle', '🔴'],
  canceled: ['black_circle', '⚫'],
}
/** The way to a deployment, named for its environment as Vercel names a preview's: Preview. */
const action = (deployment: Deployment) => (deployment.environment ? capitalized(deployment.environment) : 'Visit')

/**
 * The built-in schemas Slack has a view of: a commit is one small line, and deployments are the
 * table Vercel posts on a pull request. Any other block stays the code block it is.
 */
const VIEWS: Record<string, View> = {
  'git-commit@1': (data) => {
    const sha = short(data.sha as string)
    const title = firstLine(data.title as string)
    return {
      // The title is plain text: a commit's `*` and `_` are its own, not formatting.
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `\`${sha}\`` }, { type: 'plain_text', text: title, emoji: false }] }],
      text: `${sha} ${title}`,
      markdown: `\`${sha}\` ${literal(title)}`,
    }
  },
  'vercel-deployments@1': (data) => {
    const deployments = data.deployments as Deployment[]
    const sha = typeof data.gitSha === 'string' ? short(data.gitSha) : null
    // Vercel's columns. Updated only where a deployment says when: the others always have something to show.
    const dated = deployments.some((deployment) => secondsOf(deployment.updatedAt) !== null)
    const rows = [
      [raw('Project'), raw('Deployment'), raw('Actions'), ...(dated ? [raw('Updated')] : [])],
      ...deployments.map((deployment) => {
        const state = capitalized(deployment.state)
        const at = secondsOf(deployment.updatedAt)
        return [
          deployment.projectUrl ? rich(link(deployment.project, deployment.projectUrl)) : raw(deployment.project),
          // Its state beside its color, linking to its page on Vercel when it names one.
          rich({ type: 'emoji', name: DOT[deployment.state]![0] }, { type: 'text', text: ' ' }, deployment.inspectorUrl ? link(state, deployment.inspectorUrl) : { type: 'text', text: state }),
          deployment.url ? rich(link(action(deployment), deployment.url)) : raw(''),
          // How long ago, which Slack keeps current.
          ...(dated ? [at === null ? raw('') : rich({ type: 'date', timestamp: at, format: '{ago}', fallback: deployment.updatedAt })] : []),
        ]
      }),
    ]
    return {
      // Every row on one page: Slack shows five and pages the rest otherwise.
      blocks: [{ type: 'data_table', caption: sha ? `Deployments of ${sha}` : 'Deployments', page_size: deployments.length, rows }],
      text: deployments.map((deployment) => `${deployment.project}: ${deployment.state}`).join(', '),
      // A line per deployment, with what the table's row has.
      markdown: deployments
        .map((deployment) => {
          const at = secondsOf(deployment.updatedAt)
          return `- ${[
            `${DOT[deployment.state]![1]} **${linked(deployment.project, deployment.projectUrl)}**`,
            linked(capitalized(deployment.state), deployment.inspectorUrl),
            ...(deployment.url ? [linked(action(deployment), deployment.url)] : []),
            ...(at === null ? [] : [written(at)]),
          ].join(' · ')}`
        })
        .join('\n'),
    }
  },
}

/** Whether Slack has a view of a schema's blocks. */
export const hasView = (schema: string) => Object.hasOwn(VIEWS, schema)

const DEFINITIONS = new Map(BUILT_IN_SCHEMAS.map((schema) => [`${schema.name}@${schema.version}`, schema.schema]))

/** The blocks in a message that Slack has a view of, each with its view of its data. */
function viewed(markdown: string) {
  return findBlocks(markdown).flatMap((found) => {
    const view = VIEWS[found.id]
    const definition = DEFINITIONS.get(found.id)
    return view && definition && found.data && checkValue(definition, found.data) === null ? [{ start: found.start, end: found.end, shown: view(found.data) }] : []
  })
}

/**
 * A message for Slack with the blocks it has a view of shown as Slack's own layout: the text
 * around them stays markdown, in their place, and `text` says it all in plain words, which is
 * what a notification shows, cut to what Slack takes. Null when it has no such block, or more
 * than Slack takes in one message, so it goes out as markdown.
 */
export function slackViews(markdown: string, as: SlackText = {}): { text: string; blocks: SlackBlock[] } | null {
  const found = viewed(markdown)
  if (found.length === 0) return null
  const blocks: SlackBlock[] = []
  const text: string[] = []
  let from = 0
  let prose = 0
  let tabled = false
  // The text since the last layout block, a view Slack can't lay out here included.
  let pending = ''
  const write = () => {
    const trimmed = pending.trim()
    pending = ''
    if (!trimmed) return
    prose += trimmed.length
    blocks.push({ type: 'markdown', text: as.markdown?.(trimmed) ?? trimmed })
    text.push(as.mrkdwn?.(trimmed) ?? trimmed)
  }
  for (const { start, end, shown } of found) {
    pending += markdown.slice(from, start)
    from = end
    // One table in a message, as Slack's tables go: a second one is its markdown.
    const table = shown.blocks.some((block) => block.type === 'data_table')
    if (table && tabled) {
      pending += shown.markdown
      continue
    }
    tabled ||= table
    write()
    blocks.push(...shown.blocks)
    text.push(shown.text)
  }
  pending += markdown.slice(from)
  write()
  if (prose > MARKDOWN_MAX || blocks.length > BLOCKS_MAX) return null
  const said = Array.from(text.join('\n'))
  return { text: said.length > TEXT_MAX ? `${said.slice(0, TEXT_MAX - 1).join('')}…` : said.join(''), blocks }
}

/** A message with each block Slack has a view of as that view in markdown, for where the layout can't go: with files, or when Slack won't take it. */
export function viewsAsMarkdown(markdown: string): string {
  let out = ''
  let from = 0
  for (const { start, end, shown } of viewed(markdown)) {
    out += markdown.slice(from, start) + shown.markdown
    from = end
  }
  return out + markdown.slice(from)
}
