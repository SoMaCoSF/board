import type { Adapter, Author as ChatAuthor, Chat, Message as ChatMessage } from 'chat'
import type { BoardClient } from '../client/client.ts'
import type { ExternalAuthor, ExternalEvent } from '../contract/contract.ts'

/** A lifecycle event read from a raw platform webhook, with its dedupe key. */
export type InterceptedEvent = { event: ExternalEvent; raw: unknown; dedupe: string }

/**
 * What a platform module tells the sync core. Platform thread and channel IDs
 * here have no prefix: `C0123:1727.1` for Slack, `owner/repo:12` for GitHub.
 */
export type SyncPlatform = {
  readonly platform: string
  readonly adapter: Adapter
  /** Builds the entry's Chat SDK instance; see `createChat`. */
  createChat(): Chat
  /** Whether a new board thread can start a thread in one of its channels. */
  readonly canStartThreads: boolean
  /** Platform channel key → board channel (a mirror) or a function (an inbound handler). */
  readonly mappings: Readonly<Record<string, string | InboundFunction>>
  /** `#prs` → `C0123ABC`. */
  resolveChannel(key: string): Promise<string>
  /** Folds sub-threads into the thread a board thread maps to. */
  groupThread(thread: string): string
  /** The channel a thread is in, when it isn't Chat SDK's: GitHub splits a repo into its PRs and its issues. */
  channelOf?(thread: string): string
  /** Whether a message is its thread's first message. */
  isRoot(thread: string, messageId: string): boolean
  /** Short context for a message, e.g. the file and line of a review comment. */
  context(message: ChatMessage): string | null
  /** A mention of one of its own users (`slack:user:U0456` → `U0456`), as the platform writes it: `<@U0456>`. Without it, mentions render as names. */
  mention?(userId: string, handle: string): string
  /** A message's text as markdown, the board's format. */
  markdown(message: ChatMessage): string
  /** Its author's avatar, when the platform can tell. Best effort: null otherwise. */
  avatar?(message: ChatMessage): Promise<string | null>
  /** Lifecycle events Chat SDK doesn't model, read from a verified raw webhook. */
  intercept?(key: string, headers: Headers, body: string): InterceptedEvent[]
  /** The argument an inbound function receives. */
  handlerArgs(event: ExternalEvent, raw: unknown, board: BoardClient): unknown
}

// The functions are typed per platform module; the core only calls them.
export type InboundFunction = (args: never) => unknown

export function externalAuthor(platform: string, author: ChatAuthor): ExternalAuthor {
  const handle = author.userName || author.userId
  return {
    id: `${platform}:user:${author.userId}`,
    handle,
    name: author.fullName || handle,
    avatar: null,
    isBot: author.isBot === true,
  }
}
