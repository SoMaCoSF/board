import type { Adapter, Message as ChatMessage } from 'chat'
import type { BoardClient } from '../client/client.ts'
import type { ExternalAuthor, ExternalEvent } from '../contract/contract.ts'
import { createChat, markdownOf } from './chat.ts'
import type { SyncPlatform } from './types.ts'

/** What a Slack inbound function receives for each message in a thread the board hasn't synced yet. */
export type SlackMessage = {
  /** The Slack message ID (its `ts`). */
  id: string
  text: string
  author: ExternalAuthor
  /** `slack:C0123ABC`, as a sync target. */
  channel: string
  /** `slack:C0123ABC:1727.1234`. Pass it as `sync` to join this Slack thread. */
  thread: string
  raw: unknown
}

export type SlackHandler = (args: { message: SlackMessage; board: BoardClient }) => unknown

type SlackChannel = { id?: string; name?: string; is_member?: boolean; is_private?: boolean }
type SlackClient = {
  conversations: {
    list(args: Record<string, unknown>): Promise<{
      channels?: SlackChannel[]
      response_metadata?: { next_cursor?: string }
    }>
    info(args: { channel: string }): Promise<{ channel?: SlackChannel }>
    join(args: { channel: string }): Promise<unknown>
  }
  users?: { info(args: { user: string }): Promise<{ user?: { profile?: { image_72?: string; image_48?: string } } }> }
}

/** A Slack API error's code (`missing_scope`), with the scope it needed. */
function slackError(error: unknown): string {
  const data = (error as { data?: { error?: string; needed?: string } }).data
  if (!data?.error) return (error as Error).message
  return data.needed ? `${data.error}, needs ${data.needed}` : data.error
}

/**
 * Syncs Slack channels with board channels. Keys are channels by name
 * (`'#prs'`) or ID (`'C0123ABC'`); values are a board channel (a two-way
 * mirror) or a function that handles new threads itself. The app joins public
 * channels it isn't in; private ones need an invite.
 */
export function slack(options: {
  adapter: Adapter
  channels: Record<string, string | SlackHandler>
}): SyncPlatform {
  // With an async bot token (Vercel Connect), `.webClient` only works inside
  // `withBotToken`; the client it returns is bound to that token.
  async function client(): Promise<SlackClient | undefined> {
    const adapter = options.adapter as unknown as {
      webClient?: SlackClient
      getToken?: () => Promise<string>
      withBotToken?: <T>(token: string, fn: () => T) => T
    }
    if (!('webClient' in adapter)) return undefined
    if (!adapter.getToken || !adapter.withBotToken) return adapter.webClient
    const token = await adapter.getToken()
    return adapter.withBotToken(token, () => adapter.webClient)
  }

  // One listing resolves every name. A miss lists again, since the channel may be
  // new (the sync engine throttles retries). Without `groups:read`, Slack refuses
  // to list private channels at all, so the listing falls back to public ones.
  let listing: Promise<SlackChannel[]> | undefined
  let publicOnly = false
  async function list(client: SlackClient, types: string): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = []
    let cursor: string | undefined
    do {
      const page = await client.conversations.list({
        types,
        exclude_archived: true,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      })
      channels.push(...(page.channels ?? []))
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    return channels
  }
  async function listAll(client: SlackClient): Promise<SlackChannel[]> {
    if (!publicOnly)
      try {
        return await list(client, 'public_channel,private_channel')
      } catch (error) {
        if (!slackError(error).startsWith('missing_scope')) throw error
        publicOnly = true
      }
    return list(client, 'public_channel')
  }
  function channels(client: SlackClient, fresh: boolean) {
    if (fresh || !listing) {
      const promise = listAll(client)
      promise.catch(() => {
        if (listing === promise) listing = undefined
      })
      listing = promise
    }
    return listing
  }

  async function find(client: SlackClient, name: string): Promise<SlackChannel & { id: string }> {
    const match = (all: SlackChannel[]) =>
      all.find((channel): channel is SlackChannel & { id: string } => channel.name === name && !!channel.id)
    let found
    try {
      found = match(await channels(client, false)) ?? match(await channels(client, true))
    } catch (error) {
      throw new Error(`can't list Slack channels to find #${name} (${slackError(error)}); use its ID instead`)
    }
    if (!found)
      throw new Error(
        publicOnly
          ? `no public Slack channel named #${name} (the app lacks groups:read, so a private channel needs its ID)`
          : `no Slack channel named #${name} (a private channel shows up once the app is invited)`,
      )
    return found
  }

  // Slack only sends a channel's events to apps in it. Never throws: a channel the
  // app can't join still resolves, and the log says who to invite.
  const joined = new Map<string, Promise<void>>()
  function join(client: SlackClient, id: string, known?: SlackChannel) {
    let promise = joined.get(id)
    if (!promise) {
      promise = (async () => {
        const channel = known ?? (await client.conversations.info({ channel: id }).then((r) => r.channel, () => undefined))
        if (!channel || channel.is_member) return
        const label = channel.name ? `#${channel.name}` : id
        if (channel.is_private)
          return console.warn(`[vboard] slack: invite the app to ${label}; it can't join private channels itself`)
        try {
          await client.conversations.join({ channel: id })
        } catch (error) {
          joined.delete(id)
          console.warn(`[vboard] slack: couldn't join ${label} (${slackError(error)}); invite the app to it`)
        }
      })()
      joined.set(id, promise)
    }
    return promise
  }

  // Slack's events carry user IDs only; their pictures come from users.info, once each.
  const avatars = new Map<string, Promise<string | null>>()
  function avatarOf(user: string): Promise<string | null> {
    let promise = avatars.get(user)
    if (!promise) {
      promise = client()
        .then(async (web) => {
          const profile = (await web?.users?.info({ user }))?.user?.profile
          return profile?.image_72 ?? profile?.image_48 ?? null
        })
        .catch(() => null)
      avatars.set(user, promise)
    }
    return promise
  }

  return {
    platform: 'slack',
    adapter: options.adapter,
    createChat: () => createChat(options.adapter),
    canStartThreads: true,
    mappings: options.channels,
    // `#name` is looked up by name; anything else is a channel ID.
    async resolveChannel(key) {
      if (!key.startsWith('#')) {
        const web = await client().catch(() => undefined)
        if (web) await join(web, key)
        return key
      }
      const web = await client()
      if (!web) throw new Error(`can't look up Slack channel ${key}: use its ID instead`)
      const channel = await find(web, key.slice(1))
      await join(web, channel.id, channel)
      return channel.id
    },
    markdown: markdownOf,
    avatar: (message: ChatMessage) => (message.author.userId ? avatarOf(message.author.userId) : Promise.resolve(null)),
    groupThread: (thread) => thread,
    // A Slack thread is named by its root message's ts.
    isRoot: (thread, messageId) => thread.slice(thread.lastIndexOf(':') + 1) === messageId,
    context: () => null,
    mention: (userId) => `<@${userId}>`,
    handlerArgs(event: ExternalEvent, raw, board) {
      if (event.kind !== 'message') return { message: null, board }
      const message: SlackMessage = {
        id: event.message,
        text: event.text,
        author: event.author,
        channel: event.channel,
        thread: event.thread,
        raw,
      }
      return { message, board }
    },
  }
}
