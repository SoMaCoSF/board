/**
 * Known bot messages, shown in a form people can read. The board keeps what the
 * bot wrote (`--json` and the API return it as is); `displayText` is what a
 * person sees in `vb read`, inspect, and the copies on other platforms.
 */
import { block } from './blocks.ts'
import { BUILT_IN_SCHEMAS } from './data-schemas.ts'
import { checkValue } from './data-values.ts'

export type VercelDeployment = {
  project: string
  projectUrl: string | null
  status: string
  deploymentUrl: string | null
  previewUrl: string | null
  /** As Vercel wrote it, e.g. `Oct 6, 2026 8:30pm UTC`. */
  updated: string | null
  /** The same as a time, e.g. `2026-10-06T20:30:32.400Z`, when Vercel's comment carries one. */
  updatedAt: string | null
  skipped: boolean
}

/** Vercel for GitHub's bot account (`vercel[bot]`), as the board names it. */
export const VERCEL_BOT = 'github:user:35613825'

// `[vc]: #<hash>:<base64 JSON>`, the first line of every comment Vercel for GitHub writes.
const VERCEL_MARKER = /^\[vc\]: #\S*\r?\n/
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
const STATUS = /!\[([^\]]+)\]\(https:\/\/vercel\.com\/static\/status\/[^)]+\)\s*(?:\[[^\]]*\]\((https?:\/\/[^)\s]+)\))?/

/** The deployments in a Vercel for GitHub comment, or null when it isn't one. */
export function vercelDeployments(text: string): VercelDeployment[] | null {
  if (!VERCEL_MARKER.test(text)) return null
  const skippedAt = text.search(/<details><summary>\d+ Skipped Deployments?<\/summary>/)
  const deployments: VercelDeployment[] = []
  let offset = 0
  for (const line of text.split(/\r?\n/)) {
    const offsetOfLine = offset
    offset = text.indexOf('\n', offset) + 1 || text.length
    if (!line.startsWith('|') || /^\|\s*(Project|Name)\s*\|/.test(line) || /^\|\s*:?-/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    const status = STATUS.exec(cells[1]!)
    if (!status) continue
    // The project cell starts with an avatar wrapped in HTML; the name is its markdown link.
    const projectLink = [...cells[0]!.matchAll(LINK)].at(-1)
    const project = projectLink?.[1] ?? cells[0]!.replace(/<[^>]*>/g, '').trim()
    if (!project) continue
    const preview = cells[2] ? [...cells[2].matchAll(LINK)].find((link) => /preview/i.test(link[1]!)) : undefined
    const updated = cells[3]?.match(/<relative-time[^>]*>([^<]+)<\/relative-time>/)?.[1]?.trim() ?? (cells[3]?.replace(/<[^>]*>/g, '').trim() || null)
    const at = cells[3]?.match(/<relative-time[^>]*\sdatetime="([^"]+)"/)?.[1] ?? null
    deployments.push({
      project,
      projectUrl: projectLink?.[2] ?? null,
      status: status[1]!.trim(),
      deploymentUrl: status[2] ?? null,
      previewUrl: preview?.[2] ?? null,
      updated,
      updatedAt: at !== null && !Number.isNaN(Date.parse(at)) ? at : null,
      skipped: skippedAt !== -1 && offsetOfLine > skippedAt,
    })
  }
  return deployments.length > 0 ? deployments : null
}

const ICONS: Record<string, string> = {
  ready: '✅',
  building: '⏳',
  queued: '⏳',
  initializing: '⏳',
  error: '❌',
  failed: '❌',
  canceled: '⚪',
  ignored: '⚪',
}

const link = (label: string, url: string | null) => (url ? `[${label}](${url})` : label)

/** One line per deployment: `✅ **board** · [Ready](…) · [Preview](…) · Oct 6, 2026 8:30pm UTC`. */
export function formatVercelDeployments(deployments: VercelDeployment[]): string {
  return deployments
    .map((d) => {
      const parts = [
        `${ICONS[d.status.toLowerCase()] ?? '▲'} **${link(d.project, d.projectUrl)}**`,
        `${link(d.status, d.deploymentUrl)}${d.skipped ? ' (skipped)' : ''}`,
        ...(d.previewUrl ? [link('Preview', d.previewUrl)] : []),
        ...(d.updated ? [d.updated] : []),
      ]
      return `- ${parts.join(' · ')}`
    })
    .join('\n')
}

/** The built-in schema Vercel's deployments fit: a list of them, each with its project and state. */
const DEPLOYMENTS = 'vercel-deployments@1'
const DEPLOYMENTS_DEFINITION = BUILT_IN_SCHEMAS.find((schema) => `${schema.name}@${schema.version}` === DEPLOYMENTS)!.schema
/** What Vercel calls a deployment's state in its comment, as the schema names it. */
const STATES: Record<string, string> = { queued: 'queued', initializing: 'building', building: 'building', ready: 'ready', error: 'error', failed: 'error', canceled: 'canceled', cancelled: 'canceled' }
const https = (url: string | null): url is string => url !== null && url.startsWith('https://')

/**
 * A Vercel comment's deployments as a `vercel-deployments@1` block's data, with the ones Vercel
 * skipped apart, as its comment has them. Null when the schema can't hold them: a state it
 * doesn't know, more than it lists, or none that Vercel built.
 */
export function vercelDeploymentsData(deployments: VercelDeployment[]): { data: Record<string, unknown>; skipped: VercelDeployment[] } | null {
  const skipped = deployments.filter((d) => d.skipped || d.status.toLowerCase() === 'ignored')
  const rows = deployments
    .filter((d) => !skipped.includes(d))
    .map((d) => ({
      project: d.project,
      state: STATES[d.status.toLowerCase()],
      // Vercel names its link to a deployment for what it is: a preview.
      ...(https(d.previewUrl) ? { url: d.previewUrl, environment: 'preview' } : {}),
      ...(https(d.deploymentUrl) ? { inspectorUrl: d.deploymentUrl } : {}),
      ...(https(d.projectUrl) ? { projectUrl: d.projectUrl } : {}),
      ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
    }))
  const data = { deployments: rows }
  return checkValue(DEPLOYMENTS_DEFINITION, data) === null ? { data, skipped } : null
}

/**
 * A message's text as people should see it: known bot messages in their
 * readable form, anything else as is. Only the bot itself gets that form, so
 * no one can hide a message's text behind a look-alike table.
 *
 * Where what shows it has a view of a built-in schema (`shows`), Vercel's
 * deployments are that schema's block, and the ones it skipped a line under it.
 */
export function displayText(text: string, actor: string, shows?: (schema: string) => boolean): string {
  const deployments = actor === VERCEL_BOT ? vercelDeployments(text) : null
  if (!deployments) return text
  const held = shows?.(DEPLOYMENTS) ? vercelDeploymentsData(deployments) : null
  if (!held) return `**▲ Vercel**\n${formatVercelDeployments(deployments)}`
  const skipped = held.skipped.length ? `\n\n${held.skipped.length} skipped: ${held.skipped.map((d) => link(d.project, d.projectUrl)).join(', ')}` : ''
  return `**▲ Vercel**\n\n${block(DEPLOYMENTS, held.data)}${skipped}`
}
