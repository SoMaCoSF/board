import { createServer, type Server } from 'node:http'
import { Redis } from 'ioredis'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileAccess, FULL_ACCESS, type Can } from '../src/server/access.ts'
import type { BoardEvent } from '../src/contract/contract.ts'
import { foldActors, foldMessages, foldSync, type ActorsState, type Message, type MessagesState, type SyncState } from '../src/contract/reducers.ts'
import { compileFilter, readableFilter, toMessageFilter, type ParsedFilters } from '../src/server/feed.ts'
import { postgresDb, type PgPool } from '../src/store/postgres-db.ts'
import { redisHttp } from '../src/store/redis-http.ts'
import { redisTables } from '../src/store/redis-tables.ts'
import { redis } from '../src/store/redis.ts'
import { sqliteDb } from '../src/store/sqlite-db.ts'
import { project } from '../src/store/project.ts'
import { ddl, sqlTables } from '../src/store/sql.ts'
import type { BoardStore, MessageTables } from '../src/store/types.ts'
import { pgliteDb } from './pglite-db.ts'

/** A small seeded generator, so a failing history can be replayed. */
function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  return { next, pick, chance: (p: number) => next() < p }
}

const AUTHORS = [
  { actor: 'vercel:user:u_ada', principal: 'vercel:user:u_ada', profile: null, session: null },
  { actor: 'vercel:user:u_ada+claude', principal: 'vercel:user:u_ada', profile: 'claude', session: 's1' },
  { actor: 'vercel:user:u_bo', principal: 'vercel:user:u_bo', profile: null, session: null },
  { actor: 'slack:user:U1', principal: 'slack:user:U1', profile: null, session: null },
] as const
const SEEN = [
  { actor: 'vercel:user:u_ada', kind: 'person', handle: 'ada', name: 'Ada', avatar: null },
  { actor: 'vercel:user:u_ada+claude', kind: 'agent', handle: 'ada/claude', name: 'Claude', avatar: null },
  { actor: 'vercel:user:u_bo', kind: 'person', handle: 'bo', name: 'Bo', avatar: null },
  { actor: 'slack:user:U1', kind: 'person', handle: 'sam', name: 'Sam', avatar: null },
] as const
const CHANNELS = ['dev', 'dev/sub', 'dev_x', 'ops']
const WORDS = ['PR', '#1', 'fix', 'Bug', 'deploy', 'ÉCLAIR', 'naïve', '100%', 'a_b', 'shipit']
const FILES = ['f_one', 'f_two', 'f_three', 'f_four']
const LABELS = [{ kind: 'bug' }, { kind: 'feature' }, { pr: '1' }, { pr: '2' }, { 'tag.x': 'y' }]

/** A random board history: every event type the messages fold handles, and some it ignores. */
function history(seed: number, length: number): BoardEvent[] {
  const r = random(seed)
  const events: BoardEvent[] = []
  const posted: { id: number; re: number | null; channel: string; thread: string }[] = []
  let at = Date.parse('2026-10-01T00:00:00Z')
  const push = (type: string, payload: unknown, id = `e${events.length + 1}`) => {
    at += 1000
    events.push({ index: events.length + 1, id, type, payload, createdAt: new Date(at).toISOString() } as unknown as BoardEvent)
  }
  for (const seen of SEEN) push('actor.seen', seen)
  const text = () => Array.from({ length: 1 + Math.floor(r.next() * 4) }, () => r.pick(WORDS)).join(' ')
  const labels = () => (r.chance(0.5) ? { ...r.pick(LABELS), ...(r.chance(0.3) ? r.pick(LABELS) : {}) } : {})
  const mentions = () => (r.chance(0.3) ? [r.pick(AUTHORS).actor] : [])
  const files = () => [...new Set([r.pick(FILES), r.pick(FILES)])].map((id) => ({ id, name: `${id}.png`, type: 'image/png', size: 1 }))
  while (events.length < length) {
    const author = r.pick(AUTHORS)
    const target = posted.length ? r.pick(posted) : null
    const roll = r.next()
    if (!target || roll < 0.25) {
      const id = `e${events.length + 1}`
      const channel = r.pick(CHANNELS)
      // Some come in from a platform thread, which the root then lives in.
      const imported = r.chance(0.3)
      const n = events.length + 1
      push('message.posted', {
        channel, text: text(), re: null, replyTo: null, thread: id, labels: labels(), noSync: r.chance(0.1),
        ...(r.chance(0.3) ? { attachments: files() } : {}),
        mentions: mentions(), by: author,
        origin: imported ? { channel: 'slack:C9', thread: `slack:C9:${n}`, subthread: null, message: `${n}.0`, context: null } : null,
        from: imported ? 'slack' : null,
      }, id)
      posted.push({ id: events.length, re: null, channel, thread: id })
    } else if (roll < 0.5) {
      const root = target.re ?? target.id
      const rootPost = posted.find((p) => p.id === root)!
      const imported = r.chance(0.2)
      const n = events.length + 1
      push('message.posted', {
        channel: rootPost.channel, text: text(), re: root, replyTo: target.re === null ? null : target.id, thread: rootPost.thread,
        labels: r.chance(0.2) ? labels() : {}, noSync: false, mentions: mentions(), by: author,
        origin: imported ? { channel: 'slack:C9', thread: `slack:C9:${root}`, subthread: r.chance(0.3) ? `slack:C9:${root}:s` : null, message: `${n}.0`, context: null } : null,
        from: imported ? 'slack' : null,
      })
      posted.push({ id: events.length, re: root, channel: rootPost.channel, thread: rootPost.thread })
    } else {
      const base = { id: target.id, thread: target.thread, by: author, from: null }
      const kind = r.pick(['edit', 'delete', 'react', 'unreact', 'labels', 'linked', 'synced', 'synced', 'files', 'failed', 'attach', 'attach'] as const)
      if (kind === 'edit') push('message.edited', { ...base, text: text(), mentions: mentions() })
      else if (kind === 'delete') push('message.deleted', base)
      else if (kind === 'react') push('reaction.added', { ...base, emoji: r.pick(['eyes', '+1', 'thumbs_up']) })
      else if (kind === 'unreact') push('reaction.removed', { ...base, emoji: r.pick(['eyes', 'thumbs_up']) })
      else if (kind === 'labels') push('labels.changed', { id: target.id, thread: target.thread, by: author, set: labels(), unset: r.chance(0.5) ? [r.pick(['kind', 'pr', 'tag.x'])] : [] })
      else if (kind === 'linked') push('message.linked', { ...base, links: [{ url: 'https://example.com', message: null, snapshot: null, unavailable: null }] })
      else if (kind === 'failed') push('message.sync_failed', { id: target.id, thread: target.thread, target: 'slack:C1', error: 'not_in_channel' })
      else if (kind === 'synced') {
        // A root's receipt in a channel target says which platform thread it started.
        const to = r.pick(['slack:C1', 'github:o/r:7'])
        const external = target.re === null && to === 'slack:C1' ? `slack:C1:${target.id}` : to === 'slack:C1' ? `slack:C1:${target.re}` : to
        push('message.synced', { id: target.id, thread: target.thread, target: to, external: { thread: external, message: `${target.id}.9`, ...(r.chance(0.2) ? { asUser: true } : {}) } })
      } else if (kind === 'files') push('message.files_synced', { id: target.id, thread: target.thread, target: r.pick(['slack:C1', 'slack:C9']), files: r.chance(0.2) ? null : ['F1'] })
      else {
        const to = r.pick(['slack:C1', 'github:o/r:7', 'slack:C1'])
        push('thread.synced', { thread: target.thread, target: to, cause: 'request', by: author, ...(r.chance(0.5) ? { kind: to.split(':').length > 2 ? 'thread' : 'channel' } : {}) })
      }
    }
  }
  return events
}

/** The board as the old full-state fold saw it, through `index`. */
function fold(events: readonly BoardEvent[], index = Infinity) {
  const messages: MessagesState = { byId: {}, replies: {} }
  const actors: ActorsState = { byId: {}, byHandle: {}, links: {} }
  const sync: SyncState = { threads: {}, byExternalThread: {}, copies: {}, byExternalMessage: {} }
  for (const event of events) {
    if (event.index > index) break
    foldMessages(messages, event)
    foldActors(actors, event)
    foldSync(sync, event)
  }
  return { messages, actors, sync }
}

/** `/messages` and `/threads` as they were computed over the full state. */
function expectedMessages(state: MessagesState, matches: (m: Message | undefined) => boolean, page: { before?: number; after?: number; limit: number }) {
  let found = Object.values(state.byId).filter(matches).sort((a, b) => a.id - b.id)
  if (page.before !== undefined) found = found.filter((m) => m.id < page.before!)
  return page.after !== undefined ? found.filter((m) => m.id > page.after!).slice(0, page.limit) : found.slice(-page.limit)
}
function expectedThreads(state: MessagesState, matches: (m: Message | undefined) => boolean, page: { after?: number; limit: number }) {
  const roots = new Set<number>()
  for (const message of Object.values(state.byId)) if (matches(message)) roots.add(message.re ?? message.id)
  let found = [...roots].map((id) => {
    const replies = (state.replies[id] ?? []).map((reply) => state.byId[reply]!).filter((reply) => !reply.deleted)
    const last = replies.at(-1) ?? null
    return { root: state.byId[id]!, replies: replies.length, last, at: last?.id ?? id }
  })
  found.sort((a, b) => a.at - b.at)
  found = page.after !== undefined ? found.filter((t) => t.at > page.after!).slice(0, page.limit) : found.slice(-page.limit)
  return found.map(({ root, replies, last }) => ({ root, replies, last }))
}

const FILTERS: ParsedFilters[] = [
  {},
  { channel: 'dev' },
  { channel: 'dev/' },
  { channel: 'dev_x' },
  { by: 'ada' },
  { by: 'ada/claude' },
  { by: 'sam' },
  { mentions: 'bo' },
  { mentions: 'me' },
  { from: 'board' },
  { from: 'slack' },
  { text: 'pr #1' },
  { text: 'éclair' },
  { text: '100%' },
  { text: 'a_b' },
  { label: [['kind', null]] },
  { label: [['kind', ['bug']]] },
  { label: [['kind', ['bug', 'feature']], ['pr', null]] },
  { label: [['tag.x', ['y']]], channel: 'dev/' },
  { by: 'ada', label: [['pr', ['1']]], text: 'fix' },
  { roots: true },
  { roots: true, label: [['pr', null]] },
  { roots: true, channel: 'dev/', text: 'fix' },
  { roots: true, by: 'sam', mentions: 'bo' },
]

/**
 * The conformance suite: every backend of the tables answers exactly as the
 * full-state fold does, for random histories, every filter, and every way a
 * writer and the consumer can take turns. A new backend joins `BACKENDS`.
 */
function conformance(open: () => Promise<MessageTables>) {
  async function applied(events: readonly BoardEvent[]): Promise<MessageTables> {
    const tables = await open()
    for (const event of events) await tables.apply(event)
    return tables
  }

  it.each([1, 2, 3])('agree with the full-state fold on every message, thread, and version (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages } = fold(events)
    expect(await tables.position()).toBe(events.length)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    for (const root of Object.values(messages.byId).filter((m) => m.re === null)) {
      const expected = [root, ...(messages.replies[root.id] ?? []).map((id) => messages.byId[id]!)]
      expect(await tables.thread(root.id)).toEqual(expected)
      expect(await tables.byEventId(root.thread)).toEqual(root)
    }
    for (const index of [10, 57, 200, 333]) {
      const then = fold(events, index).messages
      const ids = Object.keys(messages.byId).map(Number)
      const at = await tables.messagesAt(ids, index)
      expect(Object.fromEntries(at)).toEqual(then.byId)
    }
    await tables.close()
  })

  it.each([4, 5])('answer /messages and /threads like the in-memory filter, for every filter and page (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages, actors } = fold(events)
    const me = 'vercel:user:u_bo'
    for (const filters of FILTERS) {
      const matches = compileFilter(filters, { me, actors, messages, access: FULL_ACCESS })
      const filter = toMessageFilter(filters, { me, actors })
      for (const page of [{ limit: 50 }, { limit: 7, after: 120 }, { limit: 7, before: 300 }, { limit: 500 }]) {
        const got = await tables.messages(filter, page)
        expect(got.messages, JSON.stringify({ filters, page })).toEqual(expectedMessages(messages, matches, page))
        expect(got.position).toBe(events.length)
        const threadPage = { limit: page.limit, ...(page.after !== undefined ? { after: page.after } : {}) }
        const threads = await tables.threads(filter, threadPage)
        expect(threads.threads, JSON.stringify({ filters, page: threadPage })).toEqual(expectedThreads(messages, matches, threadPage))
      }
    }
    await tables.close()
  })

  it('let a writer apply only the very next event, never ahead of a gap', async () => {
    const events = history(7, 200)
    const tables = await open()
    // A fresh board has no position yet: the consumer starts it, from the first event.
    expect(await tables.applyNext(events[0]!)).toBe(false)
    for (const event of events.slice(0, 50)) await tables.apply(event)
    expect(await tables.applyNext(events[52]!)).toBe(false) // #51 isn't applied yet
    expect(await tables.position()).toBe(50)
    expect(await tables.applyNext(events[50]!)).toBe(true)
    expect(await tables.applyNext(events[50]!)).toBe(false) // already applied
    // Writers and the consumer take turns, in any mix; the tables end up the same.
    for (const event of events.slice(51)) {
      if (event.index % 3 === 0) expect(await tables.applyNext(event)).toBe(true)
      else await tables.apply(event)
      await tables.apply(event) // the consumer, after the writer: a no-op
    }
    const { messages } = fold(events)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    await tables.close()
  })

  it.each([8, 9])('keep the sync state the full-state fold keeps (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { sync } = fold(events)
    expect(Object.keys(sync.threads).length).toBeGreaterThan(10)
    for (const [key, thread] of Object.entries(sync.threads)) expect(await tables.syncOf(key)).toEqual(thread)
    expect(await tables.syncOf('no-such-thread')).toBeNull()
    for (const [external, thread] of Object.entries(sync.byExternalThread)) expect(await tables.threadOf(external)).toBe(thread)
    expect((await tables.externalThreads()).sort()).toEqual(Object.keys(sync.byExternalThread).sort())
    const ids = events.filter((e) => e.type === 'message.posted').map((e) => e.index)
    const copies = await tables.copiesOf(ids)
    expect(Object.fromEntries([...copies].map(([id, byTarget]) => [String(id), byTarget]))).toEqual(sync.copies)
    for (const [key, message] of Object.entries(sync.byExternalMessage)) {
      const at = key.lastIndexOf('|')
      expect(await tables.messageOf(key.slice(0, at), key.slice(at + 1))).toBe(message)
    }
    await tables.close()
  })

  it("find a person's roots since a time, for the echo check", async () => {
    const events = history(10, 300)
    const tables = await applied(events)
    const roots = Object.values(fold(events).messages.byId).filter((m) => m.re === null)
    const times = roots.map((m) => Date.parse(m.createdAt))
    for (const principal of new Set(AUTHORS.map((a) => a.principal)))
      for (const since of [0, times[10]!, times.at(-3)!, times.at(-1)! + 1]) {
        const expected = roots.filter((m) => m.by.principal === principal && Date.parse(m.createdAt) >= since)
        expect(await tables.recentRoots(principal, since)).toEqual(expected)
      }
    await tables.close()
  })

  it.each([7, 8])('answer a reader of some channels only with what it reads, for every filter (history %i)', async (seed) => {
    const events = history(seed, 400)
    const tables = await applied(events)
    const { messages, actors } = fold(events)
    const known = [...new Set(Object.values(messages.byId).map((m) => m.channel))]
    const grants: Can[] = [{ dev: ['read'] }, { 'dev/': ['read'] }, { dev_x: ['read'], ops: ['read'] }, { nowhere: ['read'] }]
    for (const can of grants) {
      const access = compileAccess(can)
      for (const filters of FILTERS) {
        const matches = compileFilter(filters, { me: null, actors, messages, access })
        const filter = readableFilter(toMessageFilter(filters, { me: null, actors }), known, access)
        const expected = expectedMessages(messages, matches, { limit: 500 })
        const got = filter.channels?.length === 0 ? [] : (await tables.messages(filter, { limit: 500 })).messages
        expect(got, JSON.stringify({ can, filters })).toEqual(expected)
        const threads = filter.channels?.length === 0 ? [] : (await tables.threads(filter, { limit: 50 })).threads
        expect(threads, JSON.stringify({ can, filters })).toEqual(expectedThreads(messages, matches, { limit: 50 }))
      }
    }
    await tables.close()
  })

  it('find the messages that carry a file, and none once deleted', async () => {
    const events = history(9, 400)
    const tables = await applied(events)
    const { messages } = fold(events)
    for (const id of FILES) {
      const carrying = Object.values(messages.byId).filter((m) => m.attachments.some((file) => file.id === id)).sort((a, b) => a.id - b.id)
      expect(carrying.length).toBeGreaterThan(0)
      expect(await tables.withAttachment(id)).toEqual(carrying)
    }
    expect(await tables.withAttachment('f_none')).toEqual([])
    await tables.close()
  })

  it('apply a message with more labels than SQLite binds in one statement', async () => {
    const by = AUTHORS[0]
    const labels = Object.fromEntries(Array.from({ length: 11_000 }, (_, i) => [`k${i}`, 'v']))
    const events = [
      { type: 'message.posted', id: 'p', payload: { channel: 'dev', text: 'many', re: null, replyTo: null, thread: 'p', labels: {}, noSync: false, mentions: [], by, origin: null, from: null } },
      { type: 'labels.changed', id: 'l', payload: { id: 1, thread: 'p', by, set: labels, unset: [] } },
    ].map((event, i) => ({ ...event, index: i + 1, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }) as unknown as BoardEvent)
    const tables = await applied(events)
    expect(await tables.position()).toBe(2)
    expect(await tables.message(1)).toEqual(fold(events).messages.byId[1])
    expect((await tables.messages({ labels: [{ key: 'k10999', values: ['v'] }] }, { limit: 5 })).messages.map((m) => m.id)).toEqual([1])
    await tables.close()
  }, 60_000)

  it('apply an event that holds NUL or a lone surrogate, and still find it', async () => {
    // The board refuses both now; a log from before may hold them, and a script or a jsonb that can't take one would stop the tables.
    const by = AUTHORS[0]
    const odd = 'a\u0000b \ud800 c\udc00'
    const events = [
      { type: 'message.posted', id: `p${odd}`, payload: { channel: 'dev', text: `naïve ${odd}`, re: null, replyTo: null, thread: `p${odd}`, labels: { kind: odd }, noSync: false, mentions: [], by, origin: { channel: 'slack:C9', thread: `slack:C9:${odd}`, subthread: null, message: `${odd}.0`, context: null }, from: 'slack' } },
      { type: 'message.posted', id: 'r', payload: { channel: 'dev', text: odd, re: 1, replyTo: null, thread: `p${odd}`, labels: {}, noSync: false, mentions: [], by, origin: null, from: null } },
      { type: 'labels.changed', id: 'l', payload: { id: 1, thread: `p${odd}`, by, set: { tag: odd }, unset: [] } },
      { type: 'thread.synced', id: 's', payload: { thread: `p${odd}`, target: `slack:C1:${odd}`, cause: 'request', by } },
      { type: 'message.synced', id: 'd', payload: { id: 2, thread: `p${odd}`, target: `slack:C1:${odd}`, external: { thread: `slack:C1:${odd}`, message: `${odd}.9` } } },
      { type: 'message.deleted', id: 'x', payload: { id: 2, thread: `p${odd}`, by, from: null } },
    ].map((event, i) => ({ ...event, index: i + 1, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }) as unknown as BoardEvent)
    const tables = await applied(events)
    const { messages } = fold(events)
    expect(await tables.position()).toBe(events.length)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    expect(await tables.byEventId(`p${odd}`)).toEqual(messages.byId[1])
    expect(await tables.threadOf(`slack:C9:${odd}`)).not.toBeNull()
    expect((await tables.messages({ text: 'naïve' }, { limit: 10 })).messages.map((m) => m.id)).toEqual([1])
    expect((await tables.threads({ labels: [{ key: 'kind', values: null }] }, { limit: 10 })).threads.map((t) => t.root.id)).toEqual([1])
    await tables.close()
  })

  it('apply each event once, however many times it is handed over', async () => {
    const events = history(6, 120)
    const tables = await open()
    for (const event of events) {
      await tables.apply(event)
      await tables.apply(event)
    }
    // A stale attempt, handed an earlier event after later ones landed, changes nothing.
    await tables.apply(events[50]!)
    const { messages } = fold(events)
    for (const message of Object.values(messages.byId)) expect(await tables.message(message.id)).toEqual(message)
    await tables.close()
  })
}

// Postgres and Redis run when a server is configured (CI has both): each backend gets its own
// schema or key prefix, so tests never share state.
const postgresUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL
let opened = 0

const database = `vboard_tables_${process.pid}_${Date.now()}`
let databaseUrl = ''
const pools: pg.Pool[] = []

/** The tables in a schema of their own, in a database of the suite's own. */
async function postgresTables(): Promise<MessageTables> {
  const schema = `t${++opened}`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` })
  pools.push(pool)
  await pool.query(`create schema ${schema}`)
  for (const statement of ddl('postgres')) await pool.query(statement)
  return sqlTables(postgresDb(async () => pool as unknown as PgPool, { owned: false }))
}

const stores: BoardStore[] = []
const clients: Redis[] = []
const tablesOf = (store: BoardStore): MessageTables => {
  stores.push(store)
  return store.tables
}

/** Upstash's REST API, in front of the test server: the transport `redisHttp` speaks. */
let rest: Server | undefined
let restUrl = ''
async function startRest() {
  const client = new Redis(redisUrl!)
  rest = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      const [command, ...args] = JSON.parse(body) as string[]
      const reply = await client.call(command!, ...args).then(
        (result) => ({ result }),
        (error: Error) => ({ error: error.message }),
      )
      response.writeHead('error' in reply ? 400 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
    })
  })
  rest.on('close', () => client.disconnect())
  await new Promise<void>((done) => rest!.listen(0, '127.0.0.1', done))
  const address = rest.address()
  restUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

const BACKENDS: { name: string; open: () => Promise<MessageTables>; enabled: boolean }[] = [
  { name: 'SQLite', open: async () => sqlTables(sqliteDb(':memory:')), enabled: true },
  { name: 'Postgres (PGlite)', open: async () => sqlTables(await pgliteDb()), enabled: true },
  { name: 'Postgres', open: postgresTables, enabled: Boolean(postgresUrl) },
  { name: 'Redis', open: async () => tablesOf(redis({ url: redisUrl!, keyPrefix: `vbt${process.pid}x${++opened}` })), enabled: Boolean(redisUrl) },
  {
    // Redis runs nothing else while a script runs, so a long read goes in several: here, every one does.
    name: 'Redis, 7 IDs a script',
    open: async () => {
      const client = new Redis(redisUrl!)
      clients.push(client)
      return redisTables((command, ...args) => client.call(command, ...args), `vbt${process.pid}x${++opened}`, { scanBudget: 7 })
    },
    enabled: Boolean(redisUrl),
  },
  {
    name: 'Redis over REST',
    open: async () => tablesOf(redisHttp({ url: restUrl, token: 'test', keyPrefix: `vbt${process.pid}x${++opened}` })),
    enabled: Boolean(redisUrl),
  },
]

beforeAll(async () => {
  if (postgresUrl) {
    const admin = new pg.Client({ connectionString: postgresUrl })
    await admin.connect()
    await admin.query(`create database ${database}`)
    await admin.end()
    const at = new URL(postgresUrl)
    at.pathname = `/${database}`
    databaseUrl = at.toString()
  }
  if (redisUrl) await startRest()
})

afterAll(async () => {
  for (const store of stores) await store.close()
  for (const client of clients) client.disconnect()
  if (redisUrl) {
    // Every key the suite wrote is under a prefix of its own.
    const client = new Redis(redisUrl)
    const keys = await client.keys(`vbt${process.pid}x*`)
    if (keys.length > 0) await client.del(...keys)
    client.disconnect()
  }
  await new Promise((done) => (rest ? rest.close(done) : done(undefined)))
  for (const pool of pools) await pool.end()
  if (postgresUrl) {
    const admin = new pg.Client({ connectionString: postgresUrl })
    await admin.connect()
    await admin.query(`drop database if exists ${database} with (force)`)
    await admin.end()
  }
})

describe("a message's version", () => {
  const by = AUTHORS[0]
  const event = (index: number, type: string, payload: object) =>
    ({ index, id: `e${index}`, type, createdAt: '2026-10-01T00:00:00.000Z', payload: { id: 5, thread: 'e5', ...payload } }) as unknown as BoardEvent
  const receipt = (index: number) => event(index, 'message.synced', { target: 'slack:C1', external: { thread: 'slack:C1:5', message: '5.9' } })

  it('is the last event that changed it, and an event that changes nothing writes nothing', () => {
    const state: MessagesState = { byId: {}, replies: {} }
    foldMessages(state, { ...event(5, 'message.posted', {}), payload: {
      channel: 'dev', text: 'hi', re: null, replyTo: null, thread: 'e5', labels: {}, noSync: false, mentions: [], by, origin: null, from: null,
    } } as BoardEvent)
    expect(state.byId[5]!.version).toBe(5)
    const react = event(6, 'reaction.added', { emoji: 'eyes', by, from: null })
    foldMessages(state, react)
    expect(state.byId[5]!.version).toBe(6)

    // Most receipts are for a delivery that never failed, and a reaction can come twice.
    for (const same of [receipt(7), { ...react, index: 8, id: 'e8' }]) {
      const before = structuredClone(state.byId[5]!)
      expect(project({ message: before, root: undefined }, same)).toEqual({})
      foldMessages(state, same)
      expect(state.byId[5]).toEqual(before)
    }

    foldMessages(state, event(9, 'message.sync_failed', { target: 'slack:C1', error: 'not_in_channel' }))
    foldMessages(state, receipt(10))
    expect(state.byId[5]).toMatchObject({ version: 10, undelivered: {} })
  })
})

describe.skipIf(!redisUrl)('the Redis tables', () => {
  it("give a subtree read a position no later than the channels it read", async () => {
    const by = AUTHORS[0]
    const post = (index: number, channel: string) =>
      ({
        type: 'message.posted', id: `p${index}`, index, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
        payload: { channel, text: `in ${channel}`, re: null, replyTo: null, thread: `p${index}`, labels: {}, noSync: false, mentions: [], by, origin: null, from: null },
      }) as unknown as BoardEvent
    const client = new Redis(redisUrl!)
    clients.push(client)
    const prefix = `vbt${process.pid}x${++opened}`
    const other = redisTables((command, ...args) => client.call(command, ...args), prefix)
    await other.apply(post(1, 'dev'))
    // A post to a new child channel lands right after the read lists the channels.
    let land: (() => Promise<void>) | null = null
    const tables = redisTables(async (command, ...args) => {
      const reply = await client.call(command, ...args)
      const listed = command === 'SMEMBERS' || (command === 'EVAL' && args.includes(`${prefix}:vboard:channels`) && args.length <= 4)
      if (listed && land) {
        const run = land
        land = null
        await run()
      }
      return reply
    }, prefix)
    land = () => other.apply(post(2, 'dev/new'))
    const { messages, position } = await tables.messages({ channel: { path: 'dev', subtree: true } }, { limit: 10 })
    // The feed from that position carries what the page missed.
    expect(messages.map((m) => m.id)).toEqual([1])
    expect(position).toBeLessThan(2)
    land = () => other.apply(post(3, 'dev/newer'))
    const threads = await tables.threads({ channel: { path: 'dev', subtree: true } }, { limit: 10 })
    expect(threads.position).toBeLessThan(3)
  })
})

describe('the SQL tables', () => {
  it("never fold a writer's event onto what it read before the event ahead of it landed", async () => {
    const by = AUTHORS[0]
    const at = (index: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()
    const events = [
      { type: 'message.posted', id: 'p', payload: { channel: 'dev', text: 'secret', re: null, replyTo: null, thread: 'p', labels: {}, noSync: false, mentions: [], by, origin: null, from: null } },
      { type: 'message.deleted', id: 'd', payload: { id: 1, thread: 'p', by, from: null } },
      { type: 'labels.changed', id: 'l', payload: { id: 1, thread: 'p', by, set: { kind: 'bug' }, unset: [] } },
    ].map((event, i) => ({ ...event, index: i + 1, createdAt: at(i) }) as unknown as BoardEvent)
    const db = sqliteDb(':memory:')
    const consumer = sqlTables(db)
    await consumer.apply(events[0]!)
    // The consumer lands the delete right after the writer's first read.
    let ahead: (() => Promise<void>) | null = () => consumer.apply(events[1]!)
    const writer = sqlTables({
      ...db,
      async all(query) {
        const rows = await db.all(query)
        const land = ahead
        ahead = null
        await land?.()
        return rows
      },
    })
    if (!(await writer.applyNext(events[2]!))) await consumer.apply(events[2]!)
    expect(await consumer.message(1)).toEqual(fold(events).messages.byId[1])
    await consumer.close()
  })
})

for (const backend of BACKENDS) describe.skipIf(!backend.enabled)(`the tables on ${backend.name}`, () => conformance(backend.open))
