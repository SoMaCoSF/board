import { ChatSyncProvider } from './chat-provider.ts'
import type { Adapter, Message as ChatMessage } from 'chat'
import type { ExternalAuthor, ExternalEvent } from '../contract/contract.ts'
import { markdownOf } from './chat.ts'
import { z } from 'zod'
import { envelope, eventSchema } from './events.ts'
import type { ReceivedEvent, ResolvedTarget, SyncContext, SyncHandler, EventMapping, RenderInput } from './provider.ts'

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

type Comment = { id: number; in_reply_to_id?: number; user?: User; body?: string }
type Repository = { name: string; owner: { login: string } }
type CommentPayload = {
  action?: string
  comment?: Comment
  issue?: { number?: number; pull_request?: unknown }
  pull_request?: { number?: number }
  repository?: Repository
}
/** The adapter's own parsing, so an edit lands on the same thread and message IDs as the comment it changes. */
type CommentParser = {
  encodeThreadId(id: { owner: string; repo: string; prNumber: number; type?: 'pr' | 'issue'; reviewCommentId?: number }): string
  parseIssueComment(comment: Comment, repository: Repository, number: number, threadId: string, type?: 'pr' | 'issue'): ChatMessage
  parseReviewComment(comment: Comment, repository: Repository, number: number, threadId: string): ChatMessage
}

type Label = { name?: string }
type Item = { labels?: Label[]; assignees?: User[] }
type GitHubItem = Item & {
  number: number
  title: string
  html_url: string
  user?: User
  state: string
  draft?: boolean
  merged?: boolean
}
type GitHubClient = {
  rest: {
    pulls: { get(args: { owner: string; repo: string; pull_number: number }): Promise<{ data: GitHubItem }> }
    issues: { get(args: { owner: string; repo: string; issue_number: number }): Promise<{ data: GitHubItem }> }
    reactions?: {
      createForIssue(args: { owner: string; repo: string; issue_number: number; content: string }): Promise<unknown>
      listForIssue(args: { owner: string; repo: string; issue_number: number; content?: string; per_page?: number }): Promise<{ data: { id: number; content: string; user: { id: number } | null }[] }>
      deleteForIssue(args: { owner: string; repo: string; issue_number: number; reaction_id: number }): Promise<unknown>
    }
  }
}

/** `good first issue` → `good-first-issue`: the part of a label key a name gives. Empty when nothing's left. */
const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[-_.]+|-+$/g, '')

/**
 * A GitHub label or assignee as a board label: `bug` → `tag.bug=bug`,
 * `julianbenegas` → `assignee.julianbenegas=julianbenegas`. The keys don't
 * name GitHub, so a filter like `--label tag.bug` holds for any platform.
 */
function tagOf(prefix: 'tag' | 'assignee', name: string | undefined): [string, string] | null {
  const key = name ? slug(name) : ''
  return key ? [`${prefix}.${key}`.slice(0, 64), name!.slice(0, 256)] : null
}

/** A PR's or issue's current labels and assignees, as board labels. */
function tagsOf(item: Item): Record<string, string> {
  const tags = [
    ...(item.labels ?? []).map((label) => tagOf('tag', label.name)),
    ...(item.assignees ?? []).map((user) => tagOf('assignee', user.login)),
  ]
  return Object.fromEntries(tags.filter((tag) => tag !== null))
}

/** Actions that change only labels and assignees, which every PR and issue event reconciles. */
const TAG_ACTIONS = ['labeled', 'unlabeled', 'assigned', 'unassigned']

/**
 * The label key prefixes the mirror owns on a GitHub root: keys under them that GitHub doesn't have are unset.
 * A prefix is owned only when the payload carries its array, so a trimmed payload doesn't unset every key.
 */
function ownedBy(item: Item): string[] {
  return [...(Array.isArray(item.labels) ? ['tag.'] : []), ...(Array.isArray(item.assignees) ? ['assignee.'] : [])]
}

type Lifecycle = Omit<Extract<ExternalEvent, { kind: 'lifecycle' }>, 'kind' | 'channel' | 'thread' | 'author'>

/** Maps a raw `pull_request`, `pull_request_review`, or `issues` webhook to a lifecycle event. */
function lifecycle(name: string, body: Record<string, unknown>): { lifecycle: Lifecycle; number: number; user: User } | null {
  const action = String(body.action ?? '')
  const sender = body.sender as User | undefined
  if (name === 'pull_request') {
    const pr = body.pull_request as { number: number; title: string; html_url: string; draft?: boolean; merged?: boolean }
    const pr_label = { pr: `${(body.repository as { full_name: string }).full_name}#${pr.number}` }
    const base = { title: `PR #${pr.number}: ${pr.title}`, url: pr.html_url, unset: [] as string[] }
    if (TAG_ACTIONS.includes(action))
      return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: `pr.${action}`, labels: {}, reply: null, createRoot: false } }
    switch (action) {
      case 'opened':
        return {
          number: pr.number,
          user: sender ?? {},
          lifecycle: { ...base, type: 'pr.opened', labels: { ...pr_label, state: pr.draft ? 'draft' : 'open' }, reply: null, createRoot: true },
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
    if (TAG_ACTIONS.includes(action))
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: `issue.${action}`, labels: {}, reply: null, createRoot: false } }
    if (action === 'opened')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.opened', labels: { ...label, state: 'open' }, reply: null, createRoot: true } }
    if (action === 'closed')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.closed', labels: { state: 'closed' }, reply: `closed by ${sender?.login ?? 'someone'}`, createRoot: false } }
    if (action === 'reopened')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.reopened', labels: { ...label, state: 'open' }, reply: `reopened by ${sender?.login ?? 'someone'}`, createRoot: true } }
  }
  return null
}

const GitHubSubject = z.object({ type: z.enum(['pull_request', 'issue']), repo: z.string(), number: z.number().int().positive() })
const NativeItem = z.looseObject({
  number: z.number(), title: z.string(), html_url: z.string(),
  body: z.string().nullable().optional(), draft: z.boolean().optional(), state: z.string().optional(),
  base: z.looseObject({ ref: z.string() }).optional(), head: z.looseObject({ ref: z.string() }).optional(),
})
export const GitHubPayload = z.looseObject({ pull_request: NativeItem.optional(), issue: NativeItem.optional(), action: z.string().optional() })
const prTypes = ['pr.opened', 'pr.ready', 'pr.draft', 'pr.reopened', 'pr.closed', 'pr.labeled', 'pr.unlabeled', 'pr.assigned', 'pr.unassigned', 'review.submitted', 'review.dismissed'] as const
const issueTypes = ['issue.opened', 'issue.closed', 'issue.reopened', 'issue.labeled', 'issue.unlabeled', 'issue.assigned', 'issue.unassigned'] as const
const [messageEvent, editedEvent, deletedEvent, reactionEvent, lifecycleEvent] = eventSchema('github', 'comment').options
const githubFields = { subject: GitHubSubject, raw: GitHubPayload }
const prLifecycle = <T extends string>(type: T) => lifecycleEvent.extend({
  type: z.literal(type), subject: GitHubSubject.extend({ type: z.literal('pull_request') }), raw: GitHubPayload.extend({ pull_request: NativeItem }),
})
const issueLifecycle = <T extends string>(type: T) => lifecycleEvent.extend({
  type: z.literal(type), subject: GitHubSubject.extend({ type: z.literal('issue') }), raw: GitHubPayload.extend({ issue: NativeItem }),
})
export const GitHubEvent = z.discriminatedUnion('type', [
  messageEvent.extend(githubFields), editedEvent.extend(githubFields), deletedEvent.extend(githubFields), reactionEvent.extend(githubFields),
  ...prTypes.map(prLifecycle), ...issueTypes.map(issueLifecycle),
])
export type GitHubEvent = z.infer<typeof GitHubEvent>

export type GitHubHandler = SyncHandler<GitHubEvent>
export type GitHubRepo = EventMapping<GitHubEvent> | { pulls?: EventMapping<GitHubEvent>; issues?: EventMapping<GitHubEvent> }
export type GitHubOptions = {
  adapter: Adapter
  render?: (input: RenderInput) => string
  repos: Record<string, GitHubRepo>
}

/**
 * Syncs GitHub repos with board channels. Keys are repos (`'owner/repo'`);
 * values are a board channel (PRs and issues become threads there), a
 * function, or `{ pulls, issues }` to send each somewhere else. Roots never
 * flow into GitHub: a board thread doesn't open an issue.
 */
export function github(options: GitHubOptions): GitHubProvider {
  return new GitHubProvider(options)
}

export class GitHubProvider extends ChatSyncProvider<GitHubEvent> {
  constructor(options: GitHubOptions) {
    super({
      render: options.render,
      platform: 'github',
      adapter: options.adapter,
      canStartThreads: false,
      mention: (actor) => actor.id.startsWith('github:user:') ? `@${actor.handle}` : null,
      resolveChannel: (key) => Promise.resolve(key),
      // Inline review threads (`owner/repo:12:rc:345`) belong to their PR (`owner/repo:12`).
      groupThread: (thread) => thread.replace(/:rc:[^:]+$/, ''),
      channelOf,
      isRoot: () => false,
      async fetchRoot(thread) {
        const match = /^([^/]+)\/([^:]+):(issue:)?(\d+)$/.exec(thread)
        if (!match) throw new Error(`invalid GitHub thread: ${thread}`)
        const [, owner, repo, issue, number] = match
        const client = (options.adapter as Adapter & { octokit: GitHubClient }).octokit.rest
        const { data } = issue
          ? await client.issues.get({ owner: owner!, repo: repo!, issue_number: Number(number) })
          : await client.pulls.get({ owner: owner!, repo: repo!, pull_number: Number(number) })
        return {
          text: `${issue ? 'Issue' : 'PR'} #${data.number}: ${data.title}\n${data.html_url}`,
          raw: issue ? { issue: data } : { pull_request: data },
          author: author(data.user),
          labels: {
            ...tagsOf(data),
            [issue ? 'issue' : 'pr']: `${owner}/${repo}#${data.number}`,
            state: issue ? data.state : data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open',
          },
        }
      },
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
      context(message: ChatMessage) {
        const raw = message.raw as { path?: string; line?: number; comment?: { path?: string; line?: number } } | null
        const path = raw?.path ?? raw?.comment?.path
        const line = raw?.line ?? raw?.comment?.line
        return path ? (line ? `${path}:${line}` : path) : null
      },
      // Chat SDK's GitHub adapter only handles new comments; edits (Vercel updating its deployment comment) and deletes come through here.
      missed(headers, body) {
        const name = headers.get('x-github-event') ?? ''
        if (name !== 'issue_comment' && name !== 'pull_request_review_comment') return []
        let payload: CommentPayload
        try {
          payload = JSON.parse(body) as CommentPayload
        } catch {
          return []
        }
        if ((payload.action !== 'edited' && payload.action !== 'deleted') || !payload.comment?.id || !payload.repository) return []
        const { comment, repository } = payload
        const adapter = options.adapter as Adapter & CommentParser
        const review = name === 'pull_request_review_comment'
        const number = review ? payload.pull_request?.number : payload.issue?.number
        if (!number) return []
        const type = review ? undefined : payload.issue?.pull_request ? 'pr' : 'issue'
        const threadId = adapter.encodeThreadId({
          owner: repository.owner.login, repo: repository.name, prNumber: number,
          ...(review ? { reviewCommentId: comment.in_reply_to_id ?? comment.id } : { type }),
        })
        const message = review
          ? adapter.parseReviewComment(comment, repository, number, threadId)
          : adapter.parseIssueComment(comment, repository, number, threadId, type)
        // The board's own comments: it made the change, so it already has it.
        if (message.author.isMe) return []
        return payload.action === 'edited'
          ? [{ kind: 'edited', message }]
          : [{ kind: 'deleted', thread: threadId, message: message.id, raw: payload }]
      },
      intercept(key, headers, body): ReceivedEvent[] {
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
        // Every PR and issue event carries all of its labels and assignees, so each one reconciles whichever it has.
        const item = (parsed.pull_request ?? parsed.issue) as Item | undefined
        if (item) Object.assign(found.lifecycle, { labels: { ...tagsOf(item), ...found.lifecycle.labels }, owns: ownedBy(item) })
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
      async resolveTarget(target): Promise<ResolvedTarget> {
        if (!/^[^/]+\/[^:]+(?::(?:issue:)?\d+(?::rc:[^:]+)?)?$/.test(target)) throw new Error(`invalid GitHub target: ${target}`)
        const at = target.indexOf(':')
        return { target, channel: at === -1 ? target : channelOf(target), kind: at === -1 ? 'channel' : 'thread' }
      },
    })
    for (const [repo, value] of Object.entries(options.repos)) {
      const { pulls, issues } = typeof value === 'object' && !('run' in value) ? value : { pulls: value, issues: value }
      if (pulls) this.map(`${repo}:pulls`, pulls)
      if (issues) this.map(`${repo}:issues`, issues)
    }
  }

  /**
   * A thread's root is the PR or issue itself, not a comment: its copy has no comment ID
   * (`root:<event>` or `lifecycle:<event>`), so its reactions go on the PR or issue.
   */
  override async react(thread: string, message: string, emoji: string, added: boolean) {
    if (/^\d+$/.test(message)) return super.react(thread, message, emoji, added)
    const match = /^([^/]+)\/([^:]+):(?:issue:)?(\d+)$/.exec(thread)
    if (!match) throw new Error(`invalid GitHub thread: ${thread}`)
    const adapter = (await this.ready()) as Adapter & {
      octokit: GitHubClient
      getOctokitForThread?(owner: string, repo: string): Promise<GitHubClient>
      botUserId?: string
      emojiToGitHubReaction?(emoji: string): string
    }
    // GitHub has eight reactions, and the adapter turns any other emoji into +1. On the PR itself
    // that reads as the bot approving (a review's looking-bunny, a person's shipit), so skip those.
    const content = adapter.emojiToGitHubReaction?.(emoji)
    if (!content || (content === '+1' && emoji !== 'thumbs_up' && emoji !== '+1')) return
    const [, owner, repo, number] = match as unknown as [string, string, string, string]
    // The adapter's own reactions use the thread's installation, which holds outside a webhook request too.
    const client = (await adapter.getOctokitForThread?.(owner, repo)) ?? adapter.octokit
    const reactions = client.rest.reactions
    if (!reactions) throw new Error('GitHub client has no reactions API')
    const where = { owner, repo, issue_number: Number(number) }
    if (added) return void (await reactions.createForIssue({ ...where, content }))
    if (adapter.botUserId === undefined) return
    const { data } = await reactions.listForIssue({ ...where, content, per_page: 100 })
    const own = data.find((reaction) => reaction.content === content && String(reaction.user?.id) === adapter.botUserId)
    if (own) await reactions.deleteForIssue({ ...where, reaction_id: own.id })
  }

  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>): GitHubEvent {
    const match = /^([^:]+):(issue:)?(\d+)/.exec(context.event.thread.slice(context.key.length + 1))
    if (!match) throw new Error(`invalid GitHub thread: ${context.event.thread}`)
    const base = envelope(this.platform, context.key, context.event, context.raw ?? {}, context.id)
    return GitHubEvent.parse({
      ...base,
      type: context.event.kind === 'message' ? 'comment' : base.type,
      subject: { type: match[2] ? 'issue' : 'pull_request', repo: match[1], number: Number(match[3]) },
    })
  }
}
