import { findBlocks } from '../contract/blocks.ts'
import { BUILT_IN_SCHEMAS } from '../contract/data-schemas.ts'
import { checkValue } from '../contract/data-values.ts'

/** One of Slack's layout blocks, as its API takes it. */
export type SlackBlock = { type: string } & Record<string, unknown>

/** How Slack shows a block's data: its layout blocks, and the same in plain words for a notification. */
type View = (data: Record<string, unknown>) => { blocks: SlackBlock[]; text: string }

/** The most text Slack takes across a message's `markdown` blocks. */
const MARKDOWN_MAX = 12_000
/** The most layout blocks Slack takes in a message. */
const BLOCKS_MAX = 50

const raw = (text: string) => ({ type: 'raw_text', text: text || ' ' })
const linked = (text: string, url: string) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', text, url }] }] })
const short = (sha: string) => sha.slice(0, 7)
const firstLine = (text: string) => text.trim().split('\n')[0]!.trim()
/** A URL's host, or the URL as written when it has none. */
const hostOf = (url: string) => (URL.canParse(url) && new URL(url).host) || url
const capitalized = (word: string) => word.slice(0, 1).toUpperCase() + word.slice(1)

type Deployment = { url: string; state: string; project?: string; environment?: string; inspectorUrl?: string }

/**
 * The built-in schemas Slack has a view of: a commit is one small line, and deployments are a
 * table with a row each, its name linking to it. Any other block stays the code block it is.
 */
const VIEWS: Record<string, View> = {
  'git-commit@1': (data) => {
    const sha = short(data.sha as string)
    const title = firstLine(data.title as string)
    return {
      // The title is plain text: a commit's `*` and `_` are its own, not formatting.
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `\`${sha}\`` }, { type: 'plain_text', text: title, emoji: false }] }],
      text: `${sha} ${title}`,
    }
  },
  'vercel-deployments@1': (data) => {
    const deployments = data.deployments as Deployment[]
    const sha = typeof data.gitSha === 'string' ? short(data.gitSha) : null
    const name = (deployment: Deployment) => deployment.project ?? hostOf(deployment.url)
    // A column only where a deployment has something to put in it.
    const environments = deployments.some((deployment) => deployment.environment)
    const inspectors = deployments.some((deployment) => deployment.inspectorUrl)
    const rows = [
      [raw('Deployment'), raw('State'), ...(environments ? [raw('Environment')] : []), ...(inspectors ? [raw('Inspector')] : [])],
      ...deployments.map((deployment) => [
        linked(name(deployment), deployment.url),
        raw(capitalized(deployment.state)),
        ...(environments ? [raw(deployment.environment ?? '')] : []),
        ...(inspectors ? [deployment.inspectorUrl ? linked('Open', deployment.inspectorUrl) : raw('')] : []),
      ]),
    ]
    return {
      // Every row on one page: Slack shows five and pages the rest otherwise.
      blocks: [{ type: 'data_table', caption: sha ? `Deployments of ${sha}` : 'Deployments', page_size: deployments.length, rows }],
      text: deployments.map((deployment) => `${name(deployment)}: ${deployment.state}`).join(', '),
    }
  },
}

const DEFINITIONS = new Map(BUILT_IN_SCHEMAS.map((schema) => [`${schema.name}@${schema.version}`, schema.schema]))

/**
 * A message for Slack with the blocks it has a view of shown as Slack's own layout: the text
 * around them stays markdown, in their place, and `text` says it all in plain words, which is
 * what a notification shows (the text around them through `mrkdwn`, Slack's format for it). Null
 * when it has no such block, or more than Slack takes in one message, so it goes out as markdown.
 */
export function slackViews(markdown: string, mrkdwn: (markdown: string) => string = (as) => as): { text: string; blocks: SlackBlock[] } | null {
  const blocks: SlackBlock[] = []
  const text: string[] = []
  let from = 0
  let prose = 0
  let tabled = false
  const write = (segment: string) => {
    const trimmed = segment.trim()
    if (!trimmed) return
    prose += trimmed.length
    blocks.push({ type: 'markdown', text: trimmed })
    text.push(mrkdwn(trimmed))
  }
  for (const found of findBlocks(markdown)) {
    const view = VIEWS[found.id]
    const definition = DEFINITIONS.get(found.id)
    if (!view || !definition || !found.data || checkValue(definition, found.data) !== null) continue
    const shown = view(found.data)
    // One table in a message, as Slack's tables go: a second one stays the code block it is.
    const table = shown.blocks.some((block) => block.type === 'data_table')
    if (table && tabled) continue
    tabled ||= table
    write(markdown.slice(from, found.start))
    blocks.push(...shown.blocks)
    text.push(shown.text)
    from = found.end
  }
  if (from === 0 && blocks.length === 0) return null
  write(markdown.slice(from))
  if (prose > MARKDOWN_MAX || blocks.length > BLOCKS_MAX) return null
  return { text: text.join('\n'), blocks }
}
