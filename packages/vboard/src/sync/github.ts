import type { Adapter, Message as ChatMessage } from 'chat'
import type { BoardClient } from '../client/client.ts'
import type { ExternalAuthor, ExternalEvent } from '../contract/contract.ts'
import { createChat, markdownOf } from './chat.ts'
import type { InterceptedEvent, SyncPlatform } from './types.ts'

/** What a GitHub inbound function receives. */
export type GitHubEvent = {
  /** `pr.opened`, `pr.ready`, `pr.draft`, `pr.reopened`, `pr.closed`, `issue.opened`, `review.submitted`, `comment`, … */
  type: string
  /** `github:owner/repo:12`. Pass it as `sync` to join this PR or issue. */
  thread: string
  /** `github:owner/repo:pulls` or `github:owner/repo:issues`. */
  channel: string
  title: string
  url: string | null
  text: string
  author: ExternalAuthor
  raw: unknown
}

export type GitHubHandler = (args: { event: GitHubEvent; board: BoardClient }) => unknown

/** A repo's PRs and issues: one board channel (or function) for both, or one for each. Leave one out to skip it. */
export type GitHubRepo = string | GitHubHandler | { pulls?: string | GitHubHandler; issues?: string | GitHubHandler }

/** `owner/repo:12` (and its review threads) → `owner/repo:pulls`; `owner/repo:issue:3` → `owner/repo:issues`. */
function channelOf(thread: string): string {
  const match = /^([^:]+):(issue:)?\d+/.exec(thread)
  return match ? `${match[1]}:${match[2] ? 'issues' : 'pulls'}` : thread
}

type User = { login?: string; id?: number; type?: string; avatar_url?: string }

const author = (user: User | undefined): ExternalAuthor => ({
  id: `github:user:${user?.id ?? 'unknown'}`,
  handle: user?.login ?? 'unknown',
  name: user?.login ?? 'unknown',
  avatar: user?.avatar_url ?? null,
  isBot: user?.type === 'Bot',
})

type Lifecycle = Omit<Extract<ExternalEvent, { kind: 'lifecycle' }>, 'kind' | 'channel' | 'thread' | 'author'>

/** Maps a raw `pull_request`, `pull_request_review`, or `issues` webhook to a lifecycle event. */
function lifecycle(name: string, body: Record<string, unknown>): { lifecycle: Lifecycle; number: number; user: User } | null {
  const action = String(body.action ?? '')
  const sender = body.sender as User | undefined
  if (name === 'pull_request') {
    const pr = body.pull_request as { number: number; title: string; html_url: string; draft?: boolean; merged?: boolean }
    const pr_label = { pr: `${(body.repository as { full_name: string }).full_name}#${pr.number}` }
    const base = { title: `PR #${pr.number}: ${pr.title}`, url: pr.html_url, unset: [] as string[] }
    switch (action) {
      case 'opened':
        return {
          number: pr.number,
          user: sender ?? {},
          lifecycle: { ...base, type: 'pr.opened', labels: { ...pr_label, state: pr.draft ? 'draft' : 'open' }, reply: null, createRoot: !pr.draft },
        }
      case 'ready_for_review':
        return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'pr.ready', labels: { ...pr_label, state: 'open' }, reply: null, createRoot: true } }
      case 'converted_to_draft':
        return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'pr.draft', labels: { state: 'draft' }, reply: null, createRoot: false } }
      case 'reopened':
        return {
          number: pr.number,
          user: sender ?? {},
          lifecycle: { ...base, type: 'pr.reopened', labels: { ...pr_label, state: 'open' }, reply: `reopened by ${sender?.login ?? 'someone'}`, createRoot: true },
        }
      case 'closed':
        return {
          number: pr.number,
          user: sender ?? {},
          lifecycle: {
            ...base,
            type: 'pr.closed',
            labels: { state: pr.merged ? 'merged' : 'closed' },
            reply: `${pr.merged ? 'merged' : 'closed'} by ${sender?.login ?? 'someone'}`,
            createRoot: false,
          },
        }
      default:
        return null
    }
  }
  if (name === 'pull_request_review') {
    const pr = body.pull_request as { number: number; title: string; html_url: string }
    const review = body.review as { state?: string; body?: string | null }
    const base = { title: `PR #${pr.number}: ${pr.title}`, url: pr.html_url, createRoot: false }
    if (action === 'dismissed')
      return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'review.dismissed', labels: {}, unset: ['review'], reply: null } }
    if (action !== 'submitted') return null
    const state = String(review.state ?? '').toLowerCase()
    const verdict = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes requested' : null
    const text = [verdict ? `${verdict} by ${sender?.login ?? 'someone'}` : null, review.body || null].filter(Boolean).join('\n\n')
    if (!text) return null
    return {
      number: pr.number,
      user: sender ?? {},
      lifecycle: {
        ...base,
        type: 'review.submitted',
        labels: verdict ? { review: state } : {},
        unset: [],
        reply: text,
      },
    }
  }
  if (name === 'issues') {
    const issue = body.issue as { number: number; title: string; html_url: string }
    const label = { issue: `${(body.repository as { full_name: string }).full_name}#${issue.number}` }
    const base = { title: `Issue #${issue.number}: ${issue.title}`, url: issue.html_url, unset: [] as string[] }
    if (action === 'opened')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.opened', labels: { ...label, state: 'open' }, reply: null, createRoot: true } }
    if (action === 'closed')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.closed', labels: { state: 'closed' }, reply: `closed by ${sender?.login ?? 'someone'}`, createRoot: false } }
    if (action === 'reopened')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.reopened', labels: { ...label, state: 'open' }, reply: `reopened by ${sender?.login ?? 'someone'}`, createRoot: true } }
  }
  return null
}

/**
 * Syncs GitHub repos with board channels. Keys are repos (`'owner/repo'`);
 * values are a board channel (PRs and issues become threads there), a
 * function, or `{ pulls, issues }` to send each somewhere else. Roots never
 * flow into GitHub: a board thread doesn't open an issue.
 */
export function github(options: {
  adapter: Adapter
  repos: Record<string, GitHubRepo>
}): SyncPlatform {
  const mappings: Record<string, string | GitHubHandler> = {}
  for (const [repo, value] of Object.entries(options.repos)) {
    const { pulls, issues } = typeof value === 'object' ? value : { pulls: value, issues: value }
    if (pulls) mappings[`${repo}:pulls`] = pulls
    if (issues) mappings[`${repo}:issues`] = issues
  }
  return {
    platform: 'github',
    adapter: options.adapter,
    createChat: () => createChat(options.adapter),
    canStartThreads: false,
    mappings,
    resolveChannel: (key) => Promise.resolve(key),
    // Inline review threads (`owner/repo:12:rc:345`) belong to their PR (`owner/repo:12`).
    groupThread: (thread) => thread.replace(/:rc:[^:]+$/, ''),
    channelOf,
    isRoot: () => false,
    // GitHub's own markdown, tables and all; Chat SDK's text flattens it.
    markdown(message: ChatMessage) {
      const raw = message.raw as { body?: unknown; comment?: { body?: unknown } } | null
      const body = raw?.comment?.body ?? raw?.body
      return typeof body === 'string' && body.trim() ? body.trim() : markdownOf(message)
    },
    async avatar(message: ChatMessage) {
      const raw = message.raw as { user?: { avatar_url?: unknown }; comment?: { user?: { avatar_url?: unknown } } } | null
      const url = raw?.comment?.user?.avatar_url ?? raw?.user?.avatar_url
      return typeof url === 'string' ? url : null
    },
    mention: (_userId, login) => `@${login}`,
    context(message: ChatMessage) {
      const raw = message.raw as { path?: string; line?: number; comment?: { path?: string; line?: number } } | null
      const path = raw?.path ?? raw?.comment?.path
      const line = raw?.line ?? raw?.comment?.line
      return path ? (line ? `${path}:${line}` : path) : null
    },
    intercept(key, headers, body): InterceptedEvent[] {
      const name = headers.get('x-github-event') ?? ''
      if (!['pull_request', 'pull_request_review', 'issues'].includes(name)) return []
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        return []
      }
      const found = lifecycle(name, parsed)
      if (!found) return []
      const repo = (parsed.repository as { full_name: string }).full_name
      const thread = name === 'issues' ? `${key}:${repo}:issue:${found.number}` : `${key}:${repo}:${found.number}`
      const delivery = headers.get('x-github-delivery') ?? `${name}:${found.lifecycle.type}:${found.number}`
      return [
        {
          event: { kind: 'lifecycle', channel: `${key}:${repo}:${name === 'issues' ? 'issues' : 'pulls'}`, thread, author: author(found.user), ...found.lifecycle },
          raw: parsed,
          dedupe: `lifecycle:${delivery}`,
        },
      ]
    },
    handlerArgs(event: ExternalEvent, raw, board) {
      const shared = { thread: event.thread, channel: event.channel, raw }
      if (event.kind === 'lifecycle')
        return {
          event: { ...shared, type: event.type, title: event.title, url: event.url, text: event.reply ?? event.title, author: event.author },
          board,
        }
      if (event.kind === 'message')
        return { event: { ...shared, type: 'comment', title: '', url: null, text: event.text, author: event.author }, board }
      return { event: null, board }
    },
  }
}
