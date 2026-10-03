import { canonicalEmoji } from '../contract/emoji.ts'
import type { Chat, Message as ChatMessage, ReactionEvent } from 'chat'
import { idempotentId } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Store, type HandlerContext } from 'experimental-a2/server'
import type { BoardClient } from '../client/client.ts'
import {
  inboxContract,
  inboxSession,
  type BoardEvents,
  type ExternalEvent,
  type InboxEvent,
} from '../contract/contract.ts'
import {
  actorsReducer,
  externalMessageKey,
  isThreadTarget,
  messagesReducer,
  syncReducer,
  type ActorsState,
  type Message,
} from '../contract/reducers.ts'
import { MESSAGE_TEXT_MAX } from '../contract/schemas.ts'
import type { Principal } from '../server/auth.ts'
import type { BoardSession } from '../server/board.ts'
import { badRequest, notFound } from '../server/errors.ts'
import {
  writeDelete,
  writeEdit,
  writeLabels,
  writePost,
  writeReaction,
  type Identity,
  type WriteContext,
} from '../server/writes.ts'
import { externalAuthor, type SyncPlatform } from './types.ts'
import { replaceMentions } from '../contract/mentions.ts'

export type BoardBinding = {
  session: BoardSession
  writes: WriteContext
  /** A vboard client writing as `identity`, with write IDs derived from `trigger`. */
  clientAs(identity: Identity, trigger: string): BoardClient
}

const clampText = (text: string) => {
  const trimmed = text.trim() === '' ? '(no text)' : text
  return trimmed.length > MESSAGE_TEXT_MAX ? `${trimmed.slice(0, MESSAGE_TEXT_MAX - 1)}…` : trimmed
}

const jsonSafe = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

const emojiName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_+-]/g, '_')
    .slice(0, 64) || 'unknown'

/** Two-way sync between the board and its platforms, one Chat SDK instance per entry. */
export function createSyncEngine(options: {
  entries: Record<string, SyncPlatform>
  store?: A2Store | undefined
  scheduler?: A2Scheduler | undefined
}) {
  const entries = options.entries
  let binding: BoardBinding | null = null
  const bound = () => {
    if (!binding) throw new Error('sync engine used before the board bound it')
    return binding
  }

  const platformOf = (key: string): SyncPlatform => {
    const platform = entries[key]
    if (!platform) throw badRequest(`no sync entry named ${key}`)
    return platform
  }
  const keyOf = (target: string) => target.slice(0, target.indexOf(':'))
  /** `slack:C0123:1727.1` (Chat SDK) → `${key}:C0123:1727.1` (board). */
  const toExternal = (key: string, chatId: string) => `${key}:${chatId.slice(chatId.indexOf(':') + 1)}`
  /** The reverse: board external ID → Chat SDK ID. */
  const toChat = (external: string) => {
    const key = keyOf(external)
    return `${platformOf(key).adapter.name}:${external.slice(key.length + 1)}`
  }

  // --- mappings ---------------------------------------------------------------

  type Mapping = string | ((args: never) => unknown)
  /** How long a key that didn't resolve (say, a Slack channel that doesn't exist yet) waits before another try. */
  const RETRY_MS = 60_000
  const resolved = new Map<string, { map: Promise<Map<string, Mapping>>; complete: boolean; at: number }>()
  /**
   * External channel → board channel or inbound function, for one entry. Each key
   * resolves on its own: one that can't is logged and skipped, and the rest sync.
   */
  const mappings = (key: string) => {
    const cached = resolved.get(key)
    if (cached && (cached.complete || Date.now() - cached.at < RETRY_MS)) return cached.map
    const platform = platformOf(key)
    const pairs = Object.entries(platform.mappings)
    const entry = { complete: true, at: Date.now(), map: Promise.resolve(new Map<string, Mapping>()) }
    entry.map = Promise.allSettled(pairs.map(([raw]) => platform.resolveChannel(raw))).then((results) => {
      const map = new Map<string, Mapping>()
      results.forEach((result, i) => {
        const [raw, target] = pairs[i]!
        if (result.status === 'fulfilled') map.set(`${key}:${result.value}`, target)
        else {
          entry.complete = false
          console.warn(`[vboard] sync ${key}: skipping ${raw}: ${(result.reason as Error).message}`)
        }
      })
      return map
    })
    resolved.set(key, entry)
    return entry.map
  }

  async function configTargets(channel: string): Promise<string[]> {
    const targets: string[] = []
    for (const [key, platform] of Object.entries(entries)) {
      if (!platform.canStartThreads) continue
      for (const [external, target] of await mappings(key)) if (target === channel) targets.push(external)
    }
    return targets
  }

  async function normalizeTarget(target: string): Promise<string> {
    const at = target.indexOf(':')
    if (at <= 0) throw badRequest(`sync targets look like <key>:<channel or thread>, got: ${target}`)
    const key = target.slice(0, at)
    const platform = entries[key]
    if (!platform) throw badRequest(`no sync entry named ${key}`)
    const rest = target.slice(at + 1)
    if (rest.startsWith('#'))
      try {
        return `${key}:${await platform.resolveChannel(rest)}`
      } catch (error) {
        throw badRequest(`can't sync to ${target}: ${(error as Error).message}`)
      }
    return target
  }

  // --- inbound: platform → inbox --------------------------------------------------

  const chats = new Map<string, Chat>()

  async function intake(key: string, event: ExternalEvent, raw: unknown, dedupe: string) {
    const map = await mappings(key)
    const { state: sync } = await bound().session.state(syncReducer)
    if (!map.has(event.channel) && !sync.byExternalThread[event.thread]) return
    const id = await idempotentId('vboard-inbox', key, dedupe)
    await inboxServer.session(inboxSession(event.channel)).append({
      type: 'external.received',
      id,
      payload: { sync: key, event, raw: jsonSafe(raw) },
    })
  }

  function located(key: string, platform: SyncPlatform, chatThread: string) {
    const precise = toExternal(key, chatThread)
    const platformThread = precise.slice(key.length + 1)
    const grouped = `${key}:${platform.groupThread(platformThread)}`
    const channel = platform.channelOf
      ? `${key}:${platform.channelOf(platformThread)}`
      : toExternal(key, platform.adapter.channelIdFromThreadId(chatThread))
    return { channel, thread: grouped, subthread: grouped === precise ? null : precise, platformThread }
  }

  for (const [key, platform] of Object.entries(entries)) {
    const chat = platform.createChat()
    const authorOf = async (message: ChatMessage) => {
      const author = externalAuthor(platform.platform, message.author)
      const avatar = await platform.avatar?.(message).catch(() => null)
      return avatar ? { ...author, avatar } : author
    }
    const onMessage = async (_thread: unknown, message: ChatMessage) => {
      const where = located(key, platform, message.threadId)
      await intake(
        key,
        {
          kind: 'message',
          ...where,
          message: message.id,
          isRoot: platform.isRoot(where.platformThread, message.id),
          text: platform.markdown(message),
          context: platform.context(message),
          author: await authorOf(message),
        },
        message.raw,
        `message:${where.subthread ?? where.thread}|${message.id}`,
      )
    }
    chat.onNewMessage(/[\s\S]*/, onMessage)
    chat.onNewMention(onMessage)
    chat.onMessageUpdated(async (_thread, message) => {
      const where = located(key, platform, message.threadId)
      await intake(
        key,
        {
          kind: 'edited',
          channel: where.channel,
          thread: where.thread,
          subthread: where.subthread,
          message: message.id,
          text: platform.markdown(message),
          author: await authorOf(message),
        },
        message.raw,
        `edited:${where.subthread ?? where.thread}|${message.id}|${message.text}`,
      )
    })
    chat.onMessageDeleted(async (event) => {
      const where = located(key, platform, event.threadId)
      await intake(
        key,
        { kind: 'deleted', channel: where.channel, thread: where.thread, subthread: where.subthread, message: event.messageId },
        event.raw,
        `deleted:${where.subthread ?? where.thread}|${event.messageId}`,
      )
    })
    chat.onReaction(async (event: ReactionEvent) => {
      const where = located(key, platform, event.threadId)
      const stamp = (event.raw as { event_ts?: string } | null)?.event_ts ?? String(Date.now())
      await intake(
        key,
        {
          kind: 'reaction',
          channel: where.channel,
          thread: where.thread,
          subthread: where.subthread,
          message: event.messageId,
          emoji: emojiName(event.emoji?.name ?? event.rawEmoji),
          added: event.added,
          author: externalAuthor(platform.platform, event.user),
        },
        event.raw,
        `reaction:${where.subthread ?? where.thread}|${event.messageId}|${event.rawEmoji}|${event.user.userId}|${event.added}|${stamp}`,
      )
    })
    chats.set(key, chat)
  }

  /** Platform ingress: the adapter verifies the request; intake failures answer 500 so the platform retries. */
  async function handleWebhook(key: string, request: Request): Promise<Response> {
    const platform = entries[key]
    const chat = chats.get(key)
    if (!platform || !chat) throw notFound(`no sync entry named ${key}`)
    const body = platform.intercept ? await request.clone().text() : null
    const tasks: Promise<unknown>[] = []
    const webhooks = chat.webhooks as Record<string, (r: Request, o: { waitUntil: (t: Promise<unknown>) => void }) => Promise<Response>>
    const response = await webhooks[platform.adapter.name]!(request, { waitUntil: (task) => void tasks.push(task) })
    const results = await Promise.allSettled(tasks)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) {
      console.error('[vboard] intake failed', (failed as PromiseRejectedResult).reason)
      return new Response('intake failed', { status: 500 })
    }
    if (response.ok && platform.intercept && body !== null) {
      for (const draft of platform.intercept(key, request.headers, body))
        await intake(key, draft.event, draft.raw, draft.dedupe)
    }
    return response
  }

  // --- inbound: inbox → board -------------------------------------------------------

  const externalIdentity = (author: { id: string; handle: string; name: string; avatar: string | null }): Identity => {
    const principal: Principal = { id: author.id, kind: 'external', handle: author.handle, can: 'all', expiresAt: null }
    return {
      principal,
      author: { actor: author.id, principal: author.id, profile: null, session: null },
      actor: { id: author.id, kind: 'external', handle: author.handle, name: author.name, avatar: author.avatar },
    }
  }

  async function inbound(trigger: InboxEvent) {
    const { writes, session, clientAs } = bound()
    const { sync: key, event, raw } = trigger.payload
    const platform = platformOf(key)
    const target = (await mappings(key)).get(event.channel)
    const { state: sync } = await session.state(syncReducer)
    const threadKey = sync.byExternalThread[event.thread]
    const rootId = threadKey ? sync.threads[threadKey]?.root : undefined
    const writeId = (n: number) => idempotentId('vboard-inbound', trigger.id, String(n))

    switch (event.kind) {
      case 'message': {
        const identity = externalIdentity(event.author)
        const base = {
          identity,
          text: clampText(event.text),
          origin: { thread: event.thread, subthread: event.subthread, message: event.message, context: event.context },
          from: key,
          lenientMentions: true,
          id: await writeId(0),
        }
        if (rootId !== undefined) return void (await writePost(writes, { ...base, re: rootId }))
        if (typeof target === 'string') return void (await writePost(writes, { ...base, channel: target }))
        if (typeof target === 'function')
          await (target as (args: unknown) => unknown)(platform.handlerArgs(event, raw, clientAs(identity, trigger.id)))
        return
      }
      case 'edited':
      case 'deleted':
      case 'reaction': {
        const id = sync.byExternalMessage[externalMessageKey(event.subthread ?? event.thread, event.message)]
        if (id === undefined) return
        if (event.kind === 'deleted') {
          const system = externalIdentity({ id: `${platform.platform}:system`, handle: platform.platform, name: platform.platform, avatar: null })
          return void (await writeDelete(writes, { identity: system, id, from: key, asAuthor: false }))
        }
        const identity = externalIdentity(event.author)
        if (event.kind === 'edited')
          return void (await writeEdit(writes, { identity, id, text: clampText(event.text), from: key, asAuthor: false }))
        return void (await writeReaction(writes, { identity, id, emoji: event.emoji, remove: !event.added, from: key }))
      }
      case 'lifecycle': {
        const identity = externalIdentity(event.author)
        if (rootId !== undefined) {
          if (Object.keys(event.labels).length > 0 || event.unset.length > 0)
            await writeLabels(writes, { identity, id: rootId, set: event.labels, unset: event.unset })
          if (event.reply)
            await writePost(writes, { identity, re: rootId, text: clampText(event.reply), from: key, lenientMentions: true, id: await writeId(1) })
          return
        }
        if (typeof target === 'string' && event.createRoot) {
          const root = await writePost(writes, {
            identity,
            channel: target,
            text: clampText(event.url ? `${event.title}\n${event.url}` : event.title),
            labels: event.labels,
            origin: { thread: event.thread, subthread: null, message: `lifecycle:${trigger.id}`, context: null },
            from: key,
            lenientMentions: true,
            id: await writeId(0),
          })
          if (event.reply)
            await writePost(writes, { identity, re: root.id, text: clampText(event.reply), from: key, lenientMentions: true, id: await writeId(1) })
          return
        }
        if (typeof target === 'function')
          await (target as (args: unknown) => unknown)(platform.handlerArgs(event, raw, clientAs(identity, trigger.id)))
        return
      }
    }
  }

  const inboxServer = createServer({
    contract: inboxContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    handlers: {
      'external.received': {
        lane: ({ event }) => `thread:${event.payload.event.thread}`,
        handler: async (ctx) => {
          await inbound(ctx.event as InboxEvent)
        },
      },
    },
  })

  // --- outbound: board → platforms --------------------------------------------------

  const initialized = new Map<string, Promise<void>>()
  const chatFor = async (key: string) => {
    const chat = chats.get(key)
    if (!chat) throw badRequest(`no sync entry named ${key}`)
    let ready = initialized.get(key)
    if (!ready) {
      ready = chat.initialize()
      ready.catch(() => initialized.delete(key))
      initialized.set(key, ready)
    }
    await ready
    return chat
  }

  /**
   * A message's text with its mentions as the target platform writes them: its own users
   * natively (`<@U0456>` in Slack, `@login` on GitHub), anyone else by name. A mention
   * the message didn't resolve stays as written.
   */
  function renderMentions(message: Message, actors: ActorsState, key: string): string {
    if (message.mentions.length === 0) return message.text
    const platform = platformOf(key)
    const own = `${platform.platform}:user:`
    return replaceMentions(message.text, (token) => {
      const id =
        token.kind === 'actor'
          ? message.mentions.find((m) => m === token.actor)
          : message.mentions.find((m) => actors.byId[m]?.handle.toLowerCase() === token.handle)
      if (id === undefined) return null
      const actor = actors.byId[id]
      if (platform.mention && id.startsWith(own)) return platform.mention(id.slice(own.length), actor?.handle ?? id.slice(own.length))
      return actor?.name ?? actor?.handle ?? id
    })
  }

  /** A board message as markdown for a platform (`key`), which converts it to its own format. */
  function render(message: Message, actors: ActorsState, key: string, quote?: Message): { markdown: string } {
    const actor = actors.byId[message.by.actor]
    let name = actor?.name ?? message.by.actor
    if (message.by.profile && actor?.handle.includes('/')) name = `${actor.name} via ${actor.handle.split('/')[0]}`
    if (message.from) name = `${name} (${platformOf(message.from).platform})`
    const quoted = quote
      ? `> ↪ ${actors.byId[quote.by.actor]?.name ?? 'someone'}${quote.origin?.context ? ` on ${quote.origin.context}` : ''}: ${quote.text.slice(0, 140).replace(/\n/g, ' ')}\n\n`
      : ''
    return { markdown: `${quoted}**${name}**: ${renderMentions(message, actors, key)}` }
  }

  type Ctx<K extends keyof BoardEvents> = HandlerContext<BoardEvents, K>

  async function latest(ctx: Ctx<keyof BoardEvents>) {
    const [sync, messages, actors] = await Promise.all([
      ctx.session.state(syncReducer, { through: 'latest' }),
      ctx.session.state(messagesReducer, { through: 'latest' }),
      ctx.session.state(actorsReducer, { through: 'latest' }),
    ])
    return { sync: sync.state, messages: messages.state, actors: actors.state }
  }

  async function postReply(
    ctx: Ctx<keyof BoardEvents>,
    state: Awaited<ReturnType<typeof latest>>,
    message: Message,
    target: string,
    externalThread: string,
  ) {
    const replyTo = message.replyTo === null ? undefined : state.messages.byId[message.replyTo]
    const replyCopy = message.replyTo === null ? undefined : state.sync.copies[message.replyTo]?.[target]
    // A reply to a message in a platform sub-thread goes into that sub-thread; elsewhere it quotes it.
    const inSubthread = replyCopy !== undefined && replyCopy.thread !== externalThread
    const place = inSubthread ? replyCopy.thread : externalThread
    const chat = await chatFor(keyOf(target))
    const sent = await chat.thread(toChat(place)).post(render(message, state.actors, keyOf(target), inSubthread ? undefined : replyTo))
    await ctx.session.append(`receipt:${message.id}:${target}`, {
      type: 'message.synced',
      payload: { id: message.id, thread: message.thread, target, external: { thread: place, message: sent.id } },
    })
  }

  /**
   * A2 dead-letters a handler after 10 failures, and a dead letter stops its lane,
   * which is the thread's: nothing after it would sync. So a delivery retries a
   * few times, then records `message.sync_failed` and lets the thread move on.
   */
  const DELIVERY_ATTEMPTS = 5

  type Failure = { id: number; target: string; error: unknown }

  /** A platform error's code (`not_in_channel`) when it has one, else its message. */
  const describe = (error: unknown): string => {
    const code = (error as { data?: { error?: unknown } } | null)?.data?.error
    const text = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error)
    return text.slice(0, 500) || 'unknown error'
  }

  async function settle(ctx: Ctx<'thread.synced' | 'message.posted'>, thread: string, failures: Failure[]) {
    if (failures.length === 0) return
    if (ctx.attempt < DELIVERY_ATTEMPTS) throw failures[0]!.error
    for (const { id, target, error } of failures) {
      console.error(`[vboard] gave up delivering #${id} to ${target}:`, describe(error))
      await ctx.session.append(`failed:${id}:${target}`, {
        type: 'message.sync_failed',
        payload: { id, thread, target, error: describe(error) },
      })
    }
  }

  async function deliverThread(ctx: Ctx<'thread.synced'>) {
    const { thread, target } = ctx.event.payload
    if (isThreadTarget(target)) return // joining: only messages written after the join are delivered
    const state = await latest(ctx)
    const synced = state.sync.threads[thread]
    const root = synced ? state.messages.byId[synced.root] : undefined
    if (!synced || !root || root.deleted) return
    let externalThread = synced.external[target]
    if (!externalThread) {
      try {
        const chat = await chatFor(keyOf(target))
        const sent = await chat.channel(toChat(target)).post(render(root, state.actors, keyOf(target)))
        externalThread = toExternal(keyOf(target), sent.threadId)
        await ctx.session.append(`receipt:${root.id}:${target}`, {
          type: 'message.synced',
          payload: { id: root.id, thread, target, external: { thread: externalThread, message: sent.id } },
        })
      } catch (error) {
        return settle(ctx, thread, [{ id: root.id, target, error }])
      }
    }
    const failures: Failure[] = []
    for (const replyId of state.messages.replies[root.id] ?? []) {
      const reply = state.messages.byId[replyId]
      if (!reply || reply.deleted || reply.noSync || cameFrom(reply, target)) continue
      if (state.sync.copies[replyId]?.[target]) continue
      try {
        await postReply(ctx, state, reply, target, externalThread)
      } catch (error) {
        failures.push({ id: replyId, target, error })
      }
    }
    await settle(ctx, thread, failures)
  }

  /** Never deliver a message back to the platform it came from. */
  const cameFrom = (message: Message, target: string) =>
    message.origin?.thread === target || (message.from !== null && keyOf(target) === message.from)

  async function deliverPost(ctx: Ctx<'message.posted'>) {
    const { payload } = ctx.event
    if (payload.re === null || payload.noSync) return
    const state = await latest(ctx)
    const synced = state.sync.threads[payload.thread]
    const message = state.messages.byId[ctx.event.index]
    if (!synced || !message || synced.targets.length === 0) return
    const failures: Failure[] = []
    for (const target of synced.targets) {
      const externalThread = synced.external[target]
      if (!externalThread) continue // the root isn't there yet; its thread.synced handler backfills
      if (cameFrom(message, target) || state.sync.copies[message.id]?.[target]) continue
      try {
        await postReply(ctx, state, message, target, externalThread)
      } catch (error) {
        failures.push({ id: message.id, target, error })
      }
    }
    await settle(ctx, payload.thread, failures)
  }

  /** Edits, deletes, and reactions are best-effort: a platform that can't do one skips it. */
  async function deliverChange(
    ctx: Ctx<'message.edited' | 'message.deleted' | 'reaction.added' | 'reaction.removed'>,
  ) {
    const event = ctx.event
    const state = await latest(ctx)
    const copies = state.sync.copies[event.payload.id] ?? {}
    const message = state.messages.byId[event.payload.id]
    for (const [target, copy] of Object.entries(copies)) {
      if (event.payload.from !== null && keyOf(target) === event.payload.from) continue
      try {
        const adapter = (await chatFor(keyOf(target))).getAdapter(platformOf(keyOf(target)).adapter.name)
        const chatThread = toChat(copy.thread)
        if (event.type === 'message.edited' && message) await adapter.editMessage(chatThread, copy.message, render(message, state.actors, keyOf(target)))
        else if (event.type === 'message.deleted') await adapter.deleteMessage(chatThread, copy.message)
        else if (event.type === 'reaction.added') await adapter.addReaction(chatThread, copy.message, canonicalEmoji(event.payload.emoji))
        else if (event.type === 'reaction.removed') await adapter.removeReaction(chatThread, copy.message, canonicalEmoji(event.payload.emoji))
      } catch (error) {
        console.warn(`[vboard] skipped ${event.type} on ${target}:`, (error as Error).message)
      }
    }
  }

  const lane = ({ event }: { event: { payload: unknown } }) => `thread:${(event.payload as { thread: string }).thread}`

  /** Board-contract handlers for outbound delivery, one lane per thread. */
  const outboundHandlers = {
    'thread.synced': { lane, handler: async (ctx: Ctx<'thread.synced'>) => void (await deliverThread(ctx)) },
    'message.posted': { lane, handler: async (ctx: Ctx<'message.posted'>) => void (await deliverPost(ctx)) },
    'message.edited': { lane, handler: async (ctx: Ctx<'message.edited'>) => void (await deliverChange(ctx)) },
    'message.deleted': { lane, handler: async (ctx: Ctx<'message.deleted'>) => void (await deliverChange(ctx)) },
    'reaction.added': { lane, handler: async (ctx: Ctx<'reaction.added'>) => void (await deliverChange(ctx)) },
    'reaction.removed': { lane, handler: async (ctx: Ctx<'reaction.removed'>) => void (await deliverChange(ctx)) },
  }

  async function readInbox(key: string, channel: string | undefined, limit: number) {
    platformOf(key)
    const channels = channel ? [await normalizeTarget(`${key}:${channel}`)] : [...(await mappings(key)).keys()]
    const events = (
      await Promise.all(channels.map((c) => inboxServer.session(inboxSession(c)).history()))
    ).flat()
    return events
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, limit)
      .map((event) => ({
        id: event.id,
        channel: event.sessionId.replace(/^inbox:/, ''),
        createdAt: new Date(event.createdAt).toISOString(),
        ...(event.payload as object),
      }))
  }

  return {
    inboxServer,
    outboundHandlers,
    bind: (b: BoardBinding) => {
      binding = b
    },
    configTargets,
    normalizeTarget,
    handleWebhook,
    readInbox,
    /** For tests: the Chat SDK instance behind an entry. */
    chat: (key: string) => chats.get(key),
  }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>
