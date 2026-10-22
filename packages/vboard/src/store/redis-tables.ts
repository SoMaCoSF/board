import type { BoardEvent } from '../contract/contract.ts'
import { setOwn } from '../contract/own.ts'
import { externalMessageKey, type ExternalCopy, type Message, type SyncedThread } from '../contract/reducers.ts'
import { concernedMessageId, project, projectSync, syncReads, type Before, type Change, type SyncChange } from './project.ts'
import type { MessageFilter, MessageTables, Page, ThreadSummary } from './types.ts'

/** One Redis command, as A2's Redis stores send them: `call('HGET', key, field)`. */
export type RedisCall = (command: string, ...args: Array<string | number>) => Promise<unknown>

/** What a query reads of a message without parsing all of it. */
type Meta = { re: number | null; c: string; t: string; ca: number; d: boolean }

/** A root's thread summary: replies that aren't deleted, and the latest one's ID (its own when none). */
type Summary = { n: number; at: number }

/**
 * Applies an event's writes if it's the one to apply: with `next`, only the very
 * next index; otherwise any index past the position. The check and the writes are
 * one script, so a retried or superseded attempt changes nothing. Every key it
 * touches comes in KEYS: the position first, then the writes' own.
 */
const APPLY = `
local pos = tonumber(redis.call('GET', KEYS[1]) or '-1')
local index = tonumber(ARGV[1])
if ARGV[2] == 'next' then
  if pos ~= index - 1 then return 0 end
elseif pos >= index then
  return 0
end
for _, op in ipairs(cjson.decode(ARGV[3])) do
  redis.call(op[1], KEYS[op[2]], unpack(op, 3))
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`

/**
 * The scripts' shared part: which of a page of IDs match every group (one of
 * its sets each) and the text. Upstash bills each command a script runs, so a
 * page costs one ZMSCORE per set and one HMGET for the text, whatever its size.
 */
const MATCHES = `
local function matching(spec, from, ids)
  local ok = {}
  for i = 1, #ids do ok[i] = true end
  for _, group in ipairs(spec.groups) do
    -- The set the page came from holds every ID in it.
    if not (#group == 1 and KEYS[group[1]] == from) then
      local any = {}
      for _, key in ipairs(group) do
        local scores = redis.call('ZMSCORE', KEYS[key], unpack(ids))
        for i = 1, #ids do if scores[i] then any[i] = true end end
      end
      for i = 1, #ids do if not any[i] then ok[i] = false end end
    end
  end
  local metas = nil
  if spec.text ~= cjson.null then
    metas = redis.call('HMGET', KEYS[3], unpack(ids))
    for i = 1, #ids do
      if ok[i] and not string.find(cjson.decode(metas[i]).t, spec.text, 1, true) then ok[i] = false end
    end
  end
  return ok, metas
end
local function driver(spec)
  local best, size = KEYS[spec.fallback], nil
  for _, key in ipairs(spec.drivers) do
    local n = redis.call('ZCARD', KEYS[key])
    if size == nil or n < size then best, size = KEYS[key], n end
  end
  return best
end
`

/**
 * Messages that match, walking the smallest index set newest first (oldest first
 * with \`asc\`) and testing the others a page at a time, until \`limit\` or until
 * it has read \`budget\` IDs: Redis runs nothing else while a script runs, so a
 * long read goes in several. Returns the position, the matches, and where to go
 * on from (false when the set ran out). KEYS: position, messages, metas, then
 * the sets.
 */
const MESSAGES = `${MATCHES}
local spec = cjson.decode(ARGV[1])
local from = driver(spec)
local found, n, read = {}, 0, 0
local low, high = spec.min, spec.max
local more = true
while n < spec.limit do
  if read >= spec.budget then break end
  local count = math.min(200, spec.budget - read)
  local ids
  if spec.asc then ids = redis.call('ZRANGEBYSCORE', from, low, high, 'LIMIT', 0, count)
  else ids = redis.call('ZREVRANGEBYSCORE', from, high, low, 'LIMIT', 0, count) end
  if #ids == 0 then more = false break end
  local ok = matching(spec, from, ids)
  for i, id in ipairs(ids) do
    read = read + 1
    if spec.asc then low = '(' .. id else high = '(' .. id end
    if ok[i] then
      n = n + 1
      found[n] = id
      if n >= spec.limit then break end
    end
  end
end
local rows = {}
if n > 0 then rows = redis.call('HMGET', KEYS[2], unpack(found)) end
local next = false
if more and n < spec.limit then if spec.asc then next = low else next = high end end
return { redis.call('GET', KEYS[1]) or '0', rows, next }
`

/**
 * The latest threads in a channel, or across several, from their thread order
 * sets: each set's first \`limit\`, merged. KEYS: position, then the sets.
 */
const LATEST = `
local spec = cjson.decode(ARGV[1])
local roots = {}
for i = 2, #KEYS do
  local ids
  if spec.asc then ids = redis.call('ZRANGEBYSCORE', KEYS[i], spec.min, '+inf', 'WITHSCORES', 'LIMIT', 0, spec.limit)
  else ids = redis.call('ZREVRANGEBYSCORE', KEYS[i], '+inf', spec.min, 'WITHSCORES', 'LIMIT', 0, spec.limit) end
  for j = 1, #ids, 2 do roots[#roots + 1] = ids[j] roots[#roots + 1] = ids[j + 1] end
end
return { redis.call('GET', KEYS[1]) or '0', roots }
`

/**
 * The threads with a message that matches: every match's root, once, and its
 * latest reply, reading at most \`budget\` IDs. Returns the position, the roots
 * and their latest replies, and where to go on from. KEYS: position, messages,
 * metas, summaries, then the sets.
 */
const ROOTS = `${MATCHES}
local spec = cjson.decode(ARGV[1])
local from = driver(spec)
local roots, seen, read, high = {}, {}, 0, spec.max
while read < spec.budget do
  local ids = redis.call('ZREVRANGEBYSCORE', from, high, '-inf', 'LIMIT', 0, math.min(200, spec.budget - read))
  if #ids == 0 then return { redis.call('GET', KEYS[1]) or '0', roots, false } end
  local ok, metas = matching(spec, from, ids)
  local matched = {}
  for i, id in ipairs(ids) do if ok[i] then matched[#matched + 1] = id end end
  if #matched > 0 then
    if metas then
      local byId = {}
      for i, id in ipairs(ids) do byId[id] = metas[i] end
      metas = {}
      for j, id in ipairs(matched) do metas[j] = byId[id] end
    else
      metas = redis.call('HMGET', KEYS[3], unpack(matched))
    end
    local fresh = {}
    for j, id in ipairs(matched) do
      local meta = cjson.decode(metas[j])
      local root = id
      if meta.re ~= cjson.null then root = tostring(meta.re) end
      if not seen[root] then
        seen[root] = true
        fresh[#fresh + 1] = root
      end
    end
    if #fresh > 0 then
      local summaries = redis.call('HMGET', KEYS[4], unpack(fresh))
      for j, root in ipairs(fresh) do
        roots[#roots + 1] = root
        roots[#roots + 1] = cjson.decode(summaries[j]).at
      end
    end
  end
  read = read + #ids
  high = '(' .. ids[#ids]
end
return { redis.call('GET', KEYS[1]) or '0', roots, high }
`

/** Each root, its reply count, and its latest reply (false when it has none). KEYS: messages, summaries. ARGV: the roots. */
const THREAD_ROWS = `
local summaries = redis.call('HMGET', KEYS[2], unpack(ARGV))
local lasts, slot = {}, {}
for i, root in ipairs(ARGV) do
  summaries[i] = cjson.decode(summaries[i])
  if tostring(summaries[i].at) ~= root then
    lasts[#lasts + 1] = tostring(summaries[i].at)
    slot[i] = #lasts
  end
end
local rows = redis.call('HMGET', KEYS[1], unpack(ARGV))
local lastRows = {}
if #lasts > 0 then lastRows = redis.call('HMGET', KEYS[1], unpack(lasts)) end
local out = {}
for i = 1, #ARGV do
  local last = false
  if slot[i] then last = lastRows[slot[i]] end
  out[i] = { rows[i], summaries[i].n, last }
end
return out
`

/** Each message's latest version at or before ARGV[1]. KEYS: the version data, then each message's versions. */
const AT = `
local versions, slot = {}, {}
for i = 2, #KEYS do
  local found = redis.call('ZREVRANGEBYSCORE', KEYS[i], ARGV[1], '-inf', 'LIMIT', 0, 1)
  if #found > 0 then
    versions[#versions + 1] = found[1]
    slot[i - 1] = #versions
  end
end
local data = {}
if #versions > 0 then data = redis.call('HMGET', KEYS[1], unpack(versions)) end
local out = {}
for i = 1, #KEYS - 1 do
  if slot[i] then out[i] = data[slot[i]] else out[i] = false end
end
return out
`

/** Each key's hash, whole. */
const HASHES = `
local out = {}
for i = 1, #KEYS do out[i] = redis.call('HGETALL', KEYS[i]) end
return out
`

/** A person's roots posted at or after ARGV[1]. KEYS: messages, their roots by creation time. */
const RECENT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], ARGV[1], '+inf')
if #ids == 0 then return {} end
return redis.call('HMGET', KEYS[1], unpack(ids))
`

/**
 * What an event reads before it applies, in one script so it reads the primary,
 * where the position check runs: a replica can lag it. Nothing, when the
 * position says it's not the one to apply (as APPLY checks). KEYS: position,
 * messages, metas, summaries, sync threads, the copy's hash. ARGV: the index,
 * the mode, the message, its root ('' to take the message's own), the sync
 * thread, the copy ('' for none of each). Returns the message, its root's ID,
 * the root, its summary, the sync thread, and the copy.
 */
const BEFORE = `
local pos = tonumber(redis.call('GET', KEYS[1]) or '-1')
local index = tonumber(ARGV[1])
if ARGV[2] == 'next' then
  if pos ~= index - 1 then return false end
elseif pos >= index then
  return false
end
local message, root = false, ARGV[4]
if ARGV[3] ~= '' then
  message = redis.call('HGET', KEYS[2], ARGV[3])
  if message and root == '' then
    local re = cjson.decode(redis.call('HGET', KEYS[3], ARGV[3])).re
    if re ~= cjson.null then root = tostring(re) end
  end
end
local rootData, summary = false, false
if root ~= '' then
  rootData = redis.call('HGET', KEYS[2], root)
  summary = redis.call('HGET', KEYS[4], root)
end
local thread, copy = false, false
if ARGV[5] ~= '' then thread = redis.call('HGET', KEYS[5], ARGV[5]) end
if ARGV[6] ~= '' then copy = redis.call('HGET', KEYS[6], ARGV[6]) end
return { message, root, rootData, summary, thread, copy }
`

/** The newest reply in a thread that isn't deleted, other than ARGV (false when none). KEYS: the thread, metas. */
const NEWEST = `
local skip = {}
for _, id in ipairs(ARGV) do skip[id] = true end
local high = '+inf'
while true do
  local ids = redis.call('ZREVRANGEBYSCORE', KEYS[1], high, '-inf', 'LIMIT', 0, 100)
  if #ids == 0 then return false end
  local metas = redis.call('HMGET', KEYS[2], unpack(ids))
  for i, id in ipairs(ids) do
    if not skip[id] and not cjson.decode(metas[i]).d then return id end
  end
  high = '(' .. ids[#ids]
end
`

/** Every message in a set of IDs (a thread, or those carrying an attachment), a thousand to an HMGET. KEYS: the set, messages. */
const THREAD = `
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
local rows = {}
for first = 1, #ids, 1000 do
  local part = redis.call('HMGET', KEYS[2], unpack(ids, first, math.min(first + 999, #ids)))
  for i = 1, #part do rows[#rows + 1] = part[i] end
end
return rows
`

/** The position and every channel, read together. KEYS: position, channels. */
const CHANNELS = `
return { redis.call('GET', KEYS[1]) or '0', redis.call('SMEMBERS', KEYS[2]) }
`

const SEP = '\u001f'

/** How many IDs one query script reads before it hands back where it got to. */
const SCAN_BUDGET = 4000

/** JSON a script decodes: Redis's cjson refuses an escaped lone surrogate, so each goes out as U+FFFD. */
const luaJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? item.toWellFormed() : item))

/** The label sets a message is in: each key, and each key with its value. */
const labelTokens = (labels: Record<string, string>): string[] =>
  Object.entries(labels).flatMap(([key, value]) => [`l${SEP}${key}`, `lv${SEP}${key}${SEP}${value}`])

/** A message is in its own label sets and, for a reply, its root's: "on the message or its root" is one lookup. */
const inLabelSets = (own: Record<string, string>, root: Record<string, string> | null) =>
  new Set([...labelTokens(own), ...(root ? labelTokens(root) : [])])

type Op = [command: string, key: string, ...args: string[]]

/**
 * The tables on Redis: messages, versions, and sync rows in hashes and sorted
 * sets under `${prefix}:vboard`, and a sorted set per filter value, scored by
 * message ID. Each event is two scripts, one that reads what it changes and
 * one that checks the position and writes; each query is one script, which
 * walks the smallest set that applies.
 */
export function redisTables(send: RedisCall, prefix: string, options: { scanBudget?: number } = {}): MessageTables {
  // Redis keeps a lone surrogate as U+FFFD: every string goes out well-formed, so a write and the read that finds it agree.
  const call: RedisCall = (command, ...args) => send(command, ...args.map((arg) => (typeof arg === 'string' ? arg.toWellFormed() : arg)))
  const budget = options.scanBudget ?? SCAN_BUDGET
  const p = `${prefix}:vboard`
  const k = {
    pos: `${p}:pos`,
    messages: `${p}:m`,
    metas: `${p}:x`,
    summaries: `${p}:s`,
    events: `${p}:e`,
    versionData: `${p}:vd`,
    all: `${p}:i:all`,
    channels: `${p}:channels`,
    threads: `${p}:t`,
    syncThreads: `${p}:st`,
    externalThreads: `${p}:et`,
    externalMessages: `${p}:em`,
    versions: (id: number | string) => `${p}:v:${id}`,
    channel: (channel: string) => `${p}:i:c:${channel}`,
    channelThreads: (channel: string) => `${p}:t:c:${channel}`,
    /** A root's thread, it and its replies; a reply's holds just it. */
    thread: (id: number | string) => `${p}:i:r:${id}`,
    byActor: (actor: string) => `${p}:i:ba:${actor}`,
    byPrincipal: (principal: string) => `${p}:i:bp:${principal}`,
    mention: (actor: string) => `${p}:i:mn:${actor}`,
    attachment: (id: string) => `${p}:i:at:${id}`,
    from: (from: string) => `${p}:i:f:${from}`,
    /** A person's roots, by when they were posted: for the echo check. */
    rootsBy: (principal: string) => `${p}:rr:${principal}`,
    label: (token: string) => `${p}:i:${token}`,
    copies: (id: number | string) => `${p}:cp:${id}`,
  }

  const parse = <T>(value: unknown): T | null =>
    value === null || value === undefined || value === false ? null : (JSON.parse(String(value)) as T)
  const evaluate = (script: string, keys: string[], args: Array<string | number>) => call('EVAL', script, keys.length, ...keys, ...args)

  async function messagesOf(ids: readonly number[]): Promise<Map<number, Message>> {
    const out = new Map<number, Message>()
    if (ids.length === 0) return out
    const rows = (await call('HMGET', k.messages, ...ids)) as unknown[]
    ids.forEach((id, i) => {
      const message = parse<Message>(rows[i])
      if (message) out.set(id, message)
    })
    return out
  }

  type Read = Before & { rootLabels: Record<string, string> | null }

  /**
   * What the event reads before it applies: its message, its root's summary and labels, and the
   * sync rows it changes. Null when the position says it's not the one to apply.
   */
  async function before(event: BoardEvent, id: number | null, mode: 'next' | 'any') {
    const posted = event.type === 'message.posted'
    const reads = syncReads(event)
    const keys = [k.pos, k.messages, k.metas, k.summaries, k.syncThreads, reads.copy === null ? k.pos : k.copies(reads.copy[0])]
    const args = [
      event.index,
      mode,
      id === null || posted ? '' : String(id),
      posted && event.payload.re !== null ? String(event.payload.re) : '',
      reads.thread ?? '',
      reads.copy?.[1] ?? '',
    ]
    const found = (await evaluate(BEFORE, keys, args)) as unknown[] | null
    if (!found) return null
    const [data, rootId, rootData, rootSummary, thread, copy] = found
    const sync = { thread: parse<SyncedThread>(thread) ?? undefined, copy: parse<ExternalCopy>(copy) ?? undefined }
    if (id === null) return { read: null, sync }
    const message = parse<Message>(data) ?? undefined
    const summary = parse<Summary>(rootSummary)
    const root = summary ? { replies: summary.n, at: summary.at } : undefined
    const read: Read = { message, root, rootLabels: parse<Message>(rootData)?.labels ?? null }
    if (event.type === 'message.deleted' && message && !message.deleted && root?.at === id) {
      const newest = await evaluate(NEWEST, [k.thread(Number(rootId)), k.metas], [String(rootId), String(id)])
      read.previousLast = newest === null || newest === undefined || newest === false ? null : Number(newest)
    }
    return { read, sync }
  }

  /** A root's replies, when its labels changed: they're in its label sets too. */
  async function repliesOf(read: Read, change: Change): Promise<Message[]> {
    const after = change.message?.after
    if (!after || after.re !== null || change.message!.created || !change.message!.terms) return []
    if (JSON.stringify(after.labels) === JSON.stringify(read.message!.labels)) return []
    const rows = (await evaluate(THREAD, [k.thread(after.id), k.messages], [])) as unknown[]
    return rows.flatMap((row) => {
      const message = parse<Message>(row)
      return message && message.id !== after.id ? [message] : []
    })
  }

  /** The event's writes, as commands. */
  function writes(event: BoardEvent, read: Read | null, replies: Message[], change: Change, sync: SyncChange): Op[] {
    const out: Op[] = []
    const m = change.message?.after
    if (m && read) {
      const id = String(m.id)
      const created = change.message!.created
      const meta: Meta = { re: m.re, c: m.channel, t: m.text.toLowerCase(), ca: Date.parse(m.createdAt), d: m.deleted }
      out.push(['HSET', k.messages, id, JSON.stringify(m)], ['HSET', k.metas, id, luaJson(meta)])
      out.push(['ZADD', k.versions(id), String(event.index), String(event.index)], ['HSET', k.versionData, String(event.index), JSON.stringify(m)])
      if (created) {
        out.push(['HSET', k.events, event.id, id], ['SADD', k.channels, m.channel])
        for (const key of [k.all, k.channel(m.channel), k.thread(id), k.byActor(m.by.actor), k.byPrincipal(m.by.principal), k.from(m.from ?? 'board')])
          out.push(['ZADD', key, id, id])
        if (m.re !== null) out.push(['ZADD', k.thread(m.re), id, id])
        else out.push(['ZADD', k.rootsBy(m.by.principal), String(meta.ca), id])
      }
      if (change.message!.terms) {
        const old = read.message
        const rootLabels = m.re === null ? null : read.rootLabels
        const was = created ? new Set<string>() : inLabelSets(old!.labels, rootLabels)
        const is = inLabelSets(m.labels, rootLabels)
        for (const token of was) if (!is.has(token)) out.push(['ZREM', k.label(token), id])
        for (const token of is) if (!was.has(token)) out.push(['ZADD', k.label(token), id, id])
        const mentionedBefore = new Set(created ? [] : old!.mentions)
        const mentioned = new Set(m.mentions)
        for (const actor of mentionedBefore) if (!mentioned.has(actor)) out.push(['ZREM', k.mention(actor), id])
        for (const actor of mentioned) if (!mentionedBefore.has(actor)) out.push(['ZADD', k.mention(actor), id, id])
        const filesBefore = new Set(created ? [] : old!.attachments.map((file) => file.id))
        const files = new Set(m.attachments.map((file) => file.id))
        for (const file of filesBefore) if (!files.has(file)) out.push(['ZREM', k.attachment(file), id])
        for (const file of files) if (!filesBefore.has(file)) out.push(['ZADD', k.attachment(file), id, id])
        // A root's labels count for its replies too.
        for (const reply of replies) {
          const replyWas = inLabelSets(reply.labels, old!.labels)
          const replyIs = inLabelSets(reply.labels, m.labels)
          for (const token of replyWas) if (!replyIs.has(token)) out.push(['ZREM', k.label(token), String(reply.id)])
          for (const token of replyIs) if (!replyWas.has(token)) out.push(['ZADD', k.label(token), String(reply.id), String(reply.id)])
        }
      }
    }
    if (change.summary) {
      const { root, replies, at } = change.summary
      // A thread's messages are all in its root's channel.
      const channel = m?.channel ?? read?.message?.channel
      out.push(['HSET', k.summaries, String(root), JSON.stringify({ n: replies, at } satisfies Summary)], ['ZADD', k.threads, String(at), String(root)])
      if (channel !== undefined) out.push(['ZADD', k.channelThreads(channel), String(at), String(root)])
    }
    if (sync.thread) out.push(['HSET', k.syncThreads, sync.thread.key, JSON.stringify(sync.thread.data)])
    for (const [external, thread] of sync.externalThreads) out.push(['HSET', k.externalThreads, external, thread])
    for (const [message, target, copy] of sync.copies) out.push(['HSET', k.copies(message), target, JSON.stringify(copy)])
    for (const [key, message] of sync.externalMessages) out.push(['HSET', k.externalMessages, key, String(message)])
    return out
  }

  async function commit(event: BoardEvent, mode: 'next' | 'any'): Promise<boolean> {
    const id = concernedMessageId(event)
    const found = await before(event, id, mode)
    if (!found) return false
    const { read, sync: syncRead } = found
    const change = read ? project(read, event) : {}
    const replies = read ? await repliesOf(read, change) : []
    const ops = writes(event, read, replies, change, projectSync(syncRead, event))
    const keys = [k.pos]
    const slots = new Map<string, number>()
    const encoded = ops.map(([command, key, ...args]) => {
      if (!slots.has(key)) slots.set(key, keys.push(key))
      return [command, slots.get(key)!, ...args]
    })
    return Number(await evaluate(APPLY, keys, [event.index, mode, luaJson(encoded)])) === 1
  }

  /**
   * The channels under `path`, and the position that list reflects. A read's
   * position goes no further: a post in a channel newer than the list is past
   * it, so the feed from that position carries it.
   */
  async function channelsUnder(path: string) {
    const [at, all] = (await evaluate(CHANNELS, [k.pos, k.channels], [])) as [unknown, string[]]
    return { under: all.filter((c) => c.startsWith(`${path}/`)), asOf: Number(at) }
  }

  /** A filter as groups of sets, each group needing one: the query scripts' input, and the position it holds for. */
  async function compile(filter: MessageFilter, keys: string[]) {
    const slot = (key: string) => keys.push(key)
    const groups: number[][] = []
    const group = (sets: string[]) => groups.push(sets.map(slot))
    let asOf = Number.POSITIVE_INFINITY
    if (filter.channel) {
      const { path, subtree } = filter.channel
      let under: string[] = []
      if (subtree) ({ under, asOf } = await channelsUnder(path))
      group([path, ...under].map(k.channel))
    }
    if (filter.channels) group(filter.channels.map(k.channel))
    if (filter.re !== undefined) group([k.thread(filter.re)])
    if (filter.by) group([...filter.by.actors.map(k.byActor), ...filter.by.principals.map(k.byPrincipal)])
    if (filter.mentions) group(filter.mentions.map(k.mention))
    if (filter.from !== undefined) group([k.from(filter.from)])
    for (const label of filter.labels ?? [])
      group(label.values === null ? [k.label(`l${SEP}${label.key}`)] : label.values.map((value) => k.label(`lv${SEP}${label.key}${SEP}${value}`)))
    const drivers = groups.filter((sets) => sets.length === 1).map((sets) => sets[0]!)
    return { spec: { groups, drivers, fallback: slot(k.all), text: filter.text ?? null }, asOf }
  }

  return {
    async position() {
      return Number((await call('GET', k.pos)) ?? 0)
    },

    async apply(event) {
      await commit(event, 'any')
    },

    applyNext: (event) => commit(event, 'next'),

    async message(id) {
      return (await messagesOf([id])).get(id) ?? null
    },

    async byEventId(eventId) {
      const id = await call('HGET', k.events, eventId)
      return id === null || id === undefined ? null : ((await messagesOf([Number(id)])).get(Number(id)) ?? null)
    },

    async messagesAt(ids, index) {
      const out = new Map<number, Message>()
      const wanted = [...new Set(ids)]
      if (wanted.length === 0) return out
      const rows = (await evaluate(AT, [k.versionData, ...wanted.map(k.versions)], [index])) as unknown[]
      wanted.forEach((id, i) => {
        const message = parse<Message>(rows[i])
        if (message) out.set(id, message)
      })
      return out
    },

    async thread(root) {
      const ids = ((await call('ZRANGE', k.thread(root), 0, -1)) as string[]).map(Number)
      const found = await messagesOf(ids)
      return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []))
    },

    async messages(filter, page) {
      const keys = [k.pos, k.messages, k.metas]
      const asc = page.after !== undefined
      const { spec: compiled, asOf } = await compile(filter, keys)
      const spec = {
        ...compiled,
        limit: page.limit,
        budget,
        asc,
        min: asc ? `(${page.after}` : '-inf',
        max: page.before !== undefined ? `(${page.before}` : '+inf',
      }
      // The first script's position: rows a later one reads may be newer, never older, and the feed from it repeats what's newer.
      let position: number | null = null
      const messages: Message[] = []
      for (;;) {
        const [at, rows, next] = (await evaluate(MESSAGES, keys, [luaJson(spec)])) as [unknown, unknown[], string | null]
        position ??= Number(at)
        for (const row of rows) messages.push(parse<Message>(row)!)
        spec.limit = page.limit - messages.length
        if (next === null || spec.limit === 0) break
        if (asc) spec.min = next
        else spec.max = next
      }
      return { messages: asc ? messages : messages.reverse(), position: Math.min(position!, asOf) }
    },

    async threads(filter: MessageFilter, page: Page) {
      const asc = page.after !== undefined
      const { channel, channels, ...rest } = filter
      let position: number | null = null
      // Each root and when its thread last changed: its latest reply, or itself.
      const roots = new Map<string, number>()
      let asOf = Number.POSITIVE_INFINITY
      if (Object.keys(rest).length === 0 && !(channel && channels)) {
        let under: string[] = []
        if (channel?.subtree) ({ under, asOf } = await channelsUnder(channel.path))
        const sets = channels ? channels.map(k.channelThreads) : channel ? [channel.path, ...under].map(k.channelThreads) : [k.threads]
        const spec = { limit: page.limit, asc, min: asc ? `(${page.after}` : '-inf' }
        const [at, pairs] = (await evaluate(LATEST, [k.pos, ...sets], [luaJson(spec)])) as [unknown, string[]]
        position = Number(at)
        for (let i = 0; i < pairs.length; i += 2) roots.set(pairs[i]!, Number(pairs[i + 1]))
      } else {
        const keys = [k.pos, k.messages, k.metas, k.summaries]
        const compiled = await compile(filter, keys)
        asOf = compiled.asOf
        const spec = { ...compiled.spec, budget, max: '+inf' }
        for (;;) {
          const [at, pairs, next] = (await evaluate(ROOTS, keys, [luaJson(spec)])) as [unknown, Array<string | number>, string | null]
          position ??= Number(at)
          for (let i = 0; i < pairs.length; i += 2) roots.set(String(pairs[i]), Number(pairs[i + 1]))
          if (next === null) break
          spec.max = next
        }
      }
      const order = [...roots]
        .filter(([, at]) => page.after === undefined || at > page.after)
        .sort(([, a], [, b]) => (asc ? a - b : b - a))
        .slice(0, page.limit)
        .map(([root]) => root)
      const rows = order.length === 0 ? [] : ((await evaluate(THREAD_ROWS, [k.messages, k.summaries], order)) as [unknown, unknown, unknown][])
      const threads: ThreadSummary[] = rows.map(([root, replies, last]) => ({
        root: parse<Message>(root)!,
        replies: Number(replies),
        last: parse<Message>(last),
      }))
      return { threads: asc ? threads : threads.reverse(), position: Math.min(position!, asOf) }
    },

    async syncOf(thread) {
      return parse<SyncedThread>(await call('HGET', k.syncThreads, thread))
    },

    async threadOf(externalThread) {
      const thread = await call('HGET', k.externalThreads, externalThread)
      return thread === null || thread === undefined ? null : String(thread)
    },

    async copiesOf(ids) {
      const out = new Map<number, Record<string, ExternalCopy>>()
      const wanted = [...new Set(ids)]
      if (wanted.length === 0) return out
      const rows = (await evaluate(HASHES, wanted.map(k.copies), [])) as string[][]
      wanted.forEach((id, i) => {
        const flat = rows[i] ?? []
        if (flat.length === 0) return
        const copies: Record<string, ExternalCopy> = {}
        for (let at = 0; at < flat.length; at += 2) setOwn(copies, flat[at]!, JSON.parse(flat[at + 1]!) as ExternalCopy)
        out.set(id, copies)
      })
      return out
    },

    async messageOf(externalThread, platformMessage) {
      const id = await call('HGET', k.externalMessages, externalMessageKey(externalThread, platformMessage))
      return id === null || id === undefined ? null : Number(id)
    },

    async externalThreads() {
      return (await call('HKEYS', k.externalThreads)) as string[]
    },

    async withAttachment(attachment) {
      const rows = (await evaluate(THREAD, [k.attachment(attachment), k.messages], [])) as unknown[]
      return rows.flatMap((row) => {
        const message = parse<Message>(row)
        return message ? [message] : []
      })
    },

    async recentRoots(principal, since) {
      const rows = (await evaluate(RECENT, [k.messages, k.rootsBy(principal)], [since])) as unknown[]
      return rows.map((row) => parse<Message>(row)!).sort((a, b) => a.id - b.id)
    },

    async close() {},
  }
}
