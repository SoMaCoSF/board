import type { MessageView } from '../api/routes.ts'
import { BoardError, type BoardClient } from '../client/client.ts'

/**
 * Checks that a board speaks the protocol, through the SDK, as `vb` and agents use it: every
 * board answers all of it. It writes to one channel (`conformance` by default), keeps every
 * post on the board, and deletes what it posted.
 */

/** What a check is about, for the report's headings. */
export type CheckGroup = 'core' | 'schedules' | 'attachments' | 'watchers' | 'sync'

export type CheckResult = {
  group: CheckGroup
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /** Why it failed, or why it was skipped. */
  detail?: string
}

export type ConformanceReport = {
  url: string
  checks: CheckResult[]
  /** Every check passed or was skipped. */
  ok: boolean
}

export type ConformanceOptions = {
  /** Where it posts. Default `conformance`. */
  channel?: string
}

class Mismatch extends Error {}

const show = (value: unknown) => JSON.stringify(value) ?? String(value)

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Mismatch(message)
}

function same(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Mismatch(`${what}: expected ${show(expected)}, got ${show(actual)}`)
}

async function rejects(attempt: Promise<unknown>, status: number, code: string, what: string) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof BoardError && error.status === status && error.code === code) return
    throw new Mismatch(`${what}: expected ${status} ${code}, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
  throw new Mismatch(`${what}: expected ${status} ${code}, and it succeeded`)
}

/** An ID or cursor as the protocol shapes them: a string of 1 to 128 characters. */
function isRef(value: unknown, what: string) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 128, `${what} should be a string of 1 to 128 characters, got ${show(value)}`)
}

type Context = {
  board: BoardClient
  channel: string
  /** Every post carries it, so reads see this run's messages only. */
  labels: { conformance: string }
  /** The board's position before this run wrote anything. */
  start: string
  me: { actor: string; principal: string }
  root?: MessageView
  reply?: MessageView
  posted: string[]
}

type Check = { group: CheckResult['group']; name: string; run: (ctx: Context) => Promise<void | string> }

const needRoot = (ctx: Context) => {
  check(ctx.root && ctx.reply, "posting failed, so there's nothing to read")
  return { root: ctx.root, reply: ctx.reply }
}

async function post(ctx: Context, text: string, extra: { id?: string; attachments?: string[] } = {}) {
  const message = await ctx.board.post(ctx.channel, { text, labels: ctx.labels, noSync: true, ...extra })
  ctx.posted.push(message.id)
  return message
}

const CHECKS: Check[] = [
  {
    group: 'core',
    name: 'posts a message, and reads it back by its ID',
    run: async (ctx) => {
      const root = await post(ctx, 'conformance: a root')
      isRef(root.id, "a message's id")
      check(typeof root.version === 'number', `a message's version should be a number, got ${show(root.version)}`)
      const thread = await ctx.board.thread(root.id)
      same(thread.message.id, root.id, 'the thread read by that id')
      same(thread.message.text, 'conformance: a root', 'its text')
      ctx.root = root
      const reply = await ctx.board.reply(root.id, { text: 'conformance: a reply', noSync: true })
      ctx.posted.push(reply.id)
      ctx.reply = reply
    },
  },
  {
    group: 'core',
    name: "puts a reply in its root's thread",
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      same(reply.re, root.id, "the reply's re")
      const thread = await ctx.board.thread(root.id)
      check(thread.replies.some((m) => m.id === reply.id), `the thread's replies should include ${reply.id}`)
    },
  },
  {
    group: 'core',
    name: 'posts once for a client ID, however many times it is sent',
    run: async (ctx) => {
      const id = `conformance-${ctx.labels.conformance}`
      const first = await post(ctx, 'conformance: once', { id })
      const again = await post(ctx, 'conformance: once', { id })
      same(again.id, first.id, 'the second post with the same client id')
      same((await ctx.board.posted(id)).id, first.id, 'the post found by its client id')
      await rejects(ctx.board.posted(`${id}-never`), 404, 'post_not_found', 'a client id nothing was posted with')
    },
  },
  {
    group: 'core',
    name: 'raises the version with each edit, reaction, and label',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const version = async () => (await ctx.board.thread(root.id)).message
      let before = await version()
      for (const [what, change] of [
        ['an edit', () => ctx.board.edit(root.id, 'conformance: an edited root')],
        ['a reaction', () => ctx.board.react(root.id, 'eyes')],
        ['a label', () => ctx.board.label(root.id, { set: { state: 'open' } })],
      ] as const) {
        await change()
        const after = await version()
        check(after.version > before.version, `${what} should raise the version past ${before.version}, got ${after.version}`)
        before = after
      }
      same(before.text, 'conformance: an edited root', 'the edited text')
      check(before.editedAt !== null, 'an edited message should have editedAt')
      check(before.reactions.eyes?.includes(ctx.me.actor), `reactions.eyes should include ${ctx.me.actor}, got ${show(before.reactions)}`)
      same(before.labels.state, 'open', 'the label set')
      await ctx.board.label(root.id, { unset: ['state'] })
      same((await version()).labels.state, undefined, 'the label unset')
    },
  },
  {
    group: 'core',
    name: "matches a label on the message or its thread's root",
    run: async (ctx) => {
      const { reply } = needRoot(ctx)
      const { messages } = await ctx.board.messages({ channel: ctx.channel, label: ctx.labels })
      check(messages.some((m) => m.id === reply.id), "a reply should match its root's label")
    },
  },
  {
    group: 'core',
    name: 'matches only roots with roots',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const { messages } = await ctx.board.messages({ channel: ctx.channel, label: ctx.labels, roots: true })
      check(messages.some((m) => m.id === root.id), 'a root should match')
      check(messages.every((m) => m.re === null), `no reply should match, got ${show(messages.map((m) => m.id))}`)
    },
  },
  {
    group: 'core',
    name: 'reads a channel after a cursor or a message ID, oldest first',
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const page = await ctx.board.messages({ channel: ctx.channel, label: ctx.labels, after: ctx.start })
      isRef(page.cursor, "a read's cursor")
      const ids = page.messages.map((m) => m.id)
      check(ids.indexOf(root.id) !== -1 && ids.indexOf(root.id) < ids.indexOf(reply.id), `the root should come before its reply, got ${show(ids)}`)
      const later = await ctx.board.messages({ channel: ctx.channel, label: ctx.labels, after: root.id })
      check(!later.messages.some((m) => m.id === root.id), 'reading after a message should leave it out')
      check(later.messages.some((m) => m.id === reply.id), 'reading after a message should include what came after it')
    },
  },
  {
    group: 'core',
    name: 'lists threads, each with its reply count and latest reply',
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const { threads } = await ctx.board.threads({ channel: ctx.channel, label: ctx.labels })
      const found = threads.find((t) => t.message.id === root.id)
      check(found, `the threads should include ${root.id}`)
      same(found.replies, 1, 'its reply count')
      same(found.last?.id, reply.id, 'its latest reply')
    },
  },
  {
    group: 'core',
    name: 'reads events after a cursor, each with a cursor of its own',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const page = await ctx.board.poll({ channel: ctx.channel, after: ctx.start })
      isRef(page.cursor, "the events' cursor")
      const posted = page.events.find((event) => event.type === 'message.posted' && event.message?.id === root.id)
      check(posted, `the events should include ${root.id} being posted`)
      isRef(posted.cursor, "an event's cursor")
      const next = await ctx.board.poll({ channel: ctx.channel, after: page.cursor })
      check(!next.events.some((event) => event.message?.id === root.id), 'reading on from the cursor should not repeat what it read')
    },
  },
  {
    group: 'core',
    name: 'holds a long-poll open until the next event',
    run: async (ctx) => {
      const { cursor } = await ctx.board.poll({ channel: ctx.channel, label: ctx.labels })
      const waiting = ctx.board.poll({ channel: ctx.channel, label: ctx.labels, after: cursor, wait: 10 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const later = await post(ctx, 'conformance: while it waits')
      const page = await waiting
      check(page.events.some((event) => event.message?.id === later.id), 'the long-poll should return the post made while it waited')
    },
  },
  {
    group: 'core',
    name: 'deletes a message, leaving a tombstone',
    run: async (ctx) => {
      const message = await post(ctx, 'conformance: to delete')
      await ctx.board.delete(message.id)
      const { message: after } = await ctx.board.thread(message.id)
      check(after.deleted && after.text === '', `a deleted message should be deleted with no text, got ${show({ deleted: after.deleted, text: after.text })}`)
    },
  },
  {
    group: 'core',
    name: 'lists the channel and you in it',
    run: async (ctx) => {
      const channels = await ctx.board.channels()
      const found = channels.find((c) => c.path === ctx.channel)
      check(found, `the channels should include ${ctx.channel}`)
      check(typeof found.lastIndex === 'number', `a channel's lastIndex should be a number, got ${show(found.lastIndex)}`)
      const actors = await ctx.board.actors()
      check(actors.some((a) => a.id === ctx.me.actor), `the actors should include ${ctx.me.actor}`)
    },
  },
  {
    group: 'core',
    name: 'answers 404 for an ID that names nothing',
    run: async (ctx) => {
      await rejects(ctx.board.thread(`no-such-message-${ctx.labels.conformance}`), 404, 'message_not_found', 'reading a message that was never posted')
    },
  },
  {
    group: 'core',
    name: 'answers 400 for a request that does not validate',
    run: async (ctx) => {
      await rejects(ctx.board.post('Not A Channel', { text: 'conformance', noSync: true }), 400, 'invalid_request', 'posting to a malformed channel')
    },
  },
  {
    group: 'schedules',
    name: 'schedules a reply, lists it, and cancels it',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const schedule = await ctx.board.schedule({ re: root.id }, { text: 'conformance: later', noSync: true, in: '1d' })
      isRef(schedule.id, "a schedule's id")
      same(schedule.re, root.id, "the schedule's re")
      same(schedule.state, 'pending', "the schedule's state")
      const listed = await ctx.board.schedules({ re: root.id })
      check(listed.some((s) => s.id === schedule.id), `the schedules should include ${schedule.id}`)
      const { schedule: canceled } = await ctx.board.cancelSchedule(schedule.id)
      same(canceled.state, 'canceled', 'the canceled schedule')
    },
  },
  {
    group: 'attachments',
    name: 'takes a file, posts it, and gives it back',
    run: async (ctx) => {
      const bytes = new TextEncoder().encode(`conformance ${ctx.labels.conformance}\n`)
      const attachment = await ctx.board.upload({ data: bytes, name: 'conformance.txt', type: 'text/plain' })
      const message = await post(ctx, 'conformance: a file', { attachments: [attachment.id] })
      check(message.attachments.some((a) => a.id === attachment.id), 'the post should carry the file')
      const response = await ctx.board.download(attachment.id)
      same(new TextDecoder().decode(await response.arrayBuffer()), new TextDecoder().decode(bytes), "the file's bytes")
    },
  },
  {
    group: 'watchers',
    name: 'matches a registered tail, hands the match to a pull, and takes its ack',
    run: async (ctx) => {
      const registered = (await ctx.board.watchers()).find((r) => r.owner === ctx.me.principal)
      // Registering replaces a principal's watchers: never on one that has some.
      if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
        return 'this token has watchers or a sync registered here, and checking would replace them'
      await ctx.board.register({ url: null, watch: { conformance: { tail: `${ctx.channel} --label conformance=${ctx.labels.conformance}` } } })
      try {
        const message = await post(ctx, 'conformance: for a watcher')
        const deadline = Date.now() + 10_000
        let match: Awaited<ReturnType<BoardClient['matches']>>[number] | undefined
        while (!match && Date.now() < deadline) match = (await ctx.board.matches({ wait: 5 })).find((m) => m.event.message?.id === message.id)
        check(match, 'a pull should hand out the match for the post')
        same(match.watcher, 'conformance', "the match's watcher")
        await ctx.board.ack(match.id, { lease: match.lease })
        await rejects(ctx.board.ack(match.id, { lease: match.lease }), 404, 'no_match', 'acking a match twice')
      } finally {
        await ctx.board.register({ url: null, watch: {} })
      }
    },
  },
  {
    group: 'sync',
    name: "keeps sync's records: an import as a platform author, its lookups by platform ID, and a receipt",
    run: async (ctx) => {
      // A platform of its own, so nothing reaches a real one: `conformance:<run>`.
      const key = 'conformance'
      const thread = `${key}:${ctx.labels.conformance}:1`
      const author = { id: `${key}:user:${ctx.labels.conformance}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      const origin = { thread, message: '1' }
      // A sync names its entries when it registers; registering replaces the token's watchers.
      const registered = (await ctx.board.watchers()).find((registration) => registration.owner === ctx.me.principal)
      if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
        return 'this token has watchers or a sync registered here, which registering would replace'
      try {
        await ctx.board.register({ url: null, watch: {}, sync: [{ key, platform: key }] })
      } catch (error) {
        if (error instanceof BoardError && error.status === 403) return "this token can't register a sync here"
        throw error
      }
      let imported: { message: string | null }
      try {
        imported = await ctx.board.syncImport({
          op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform', labels: ctx.labels, noSync: true,
          origin: { channel: `${key}:${ctx.labels.conformance}`, thread, subthread: null, message: '1', context: null },
          id: `conformance-sync-${ctx.labels.conformance}`,
        })
      } catch (error) {
        await ctx.board.register({ url: null, watch: {} }).catch(() => {})
        if (error instanceof BoardError && error.status === 403) return `this token can't sync in ${ctx.channel}`
        throw error
      }
      const id = imported.message
      isRef(id, "an import's message")
      try {
        const message = (await ctx.board.thread(id!)).message
        same(message.by.actor, author.id, "the import's author")
        same(message.from, key, "the import's from")
        same(message.origin?.thread, thread, "the import's origin")
        const found = await ctx.board.syncFind({ thread, message: '1' })
        same(found.message, id, 'the message found by its platform IDs')
        check(found.thread !== null, 'the thread found by its platform thread')
        same((await ctx.board.syncThread(found.thread!)).root, id, "the synced thread's root")
        const again = await ctx.board.syncImport({ op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform', noSync: true, id: `conformance-sync-${ctx.labels.conformance}` })
        same(again.message, id, 'the same import, sent again')
        const external = { thread: `${key}:${ctx.labels.conformance}:2`, message: '2' }
        await ctx.board.syncReceipt({ kind: 'message', message: id!, target: `${key}:${ctx.labels.conformance}:2`, external })
        same(JSON.stringify((await ctx.board.syncCopies([id!]))[id!]?.[external.thread]), JSON.stringify(external), 'the copy its receipt recorded')
      } finally {
        // Its author is the platform user: only an import can take it down.
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin }).catch(() => {})
        await ctx.board.register({ url: null, watch: {} }).catch(() => {})
      }
    },
  },
]

/** Runs the checks against `board`, in order, and reports each. It never throws for what the board answers. */
export async function conformance(board: BoardClient, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const checks: CheckResult[] = []
  const discovery = await board.discovery().catch((error: unknown) => error as Error)
  const wrong =
    discovery instanceof Error
      ? discovery.message
      : typeof discovery.audience !== 'string' || !Array.isArray(discovery.sync)
        ? `discovery should have audience and sync, got ${show(discovery)}`
        : discovery.remote
          ? `it keeps no log: its discovery names ${discovery.remote}, so check that board`
          : null
  if (wrong !== null) {
    checks.push({ group: 'core', name: 'says in its discovery where it is', status: 'failed', detail: wrong })
    return { url: board.url, checks, ok: false }
  }
  checks.push({ group: 'core', name: 'says in its discovery where it is', status: 'passed' })
  const me = await board.me()
  const channel = options.channel ?? 'conformance'
  const ctx: Context = {
    board,
    channel,
    labels: { conformance: crypto.randomUUID().slice(0, 8) },
    start: (await board.messages({ channel, limit: 1 })).cursor,
    me,
    posted: [],
  }
  try {
    for (const { group, name, run } of CHECKS) {
      try {
        const skipped = await run(ctx)
        checks.push(skipped ? { group, name, status: 'skipped', detail: skipped } : { group, name, status: 'passed' })
      } catch (error) {
        checks.push({ group, name, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    // What it posted goes, replies first. A failure here leaves a tombstone short, not a wrong report.
    for (const id of [...ctx.posted].reverse()) await board.delete(id).catch(() => {})
  }
  return { url: board.url, checks, ok: checks.every((c) => c.status !== 'failed') }
}
