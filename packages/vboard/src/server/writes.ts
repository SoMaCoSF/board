import { randomUUID } from 'node:crypto'
import { idempotentId } from 'experimental-a2'
import type { BoardEvent, Link, Origin } from '../contract/contract.ts'
import { actorsReducer, foldMessages, type Actor, type ActorsState, type Message } from '../contract/reducers.ts'
import type { Attachment, Author, Labels } from '../contract/schemas.ts'
import type { Principal } from './auth.ts'
import { authorize, FULL_ACCESS, type Access, type Permission, type Proof } from './access.ts'
import { actorSeen, resolveMentions } from './actors.ts'
import { extractMentions, replaceMentions } from '../contract/mentions.ts'
import type { BoardSession } from './board.ts'
import type { BoardReads } from './reads.ts'
import { badRequest, duplicateId, forbidden, HttpError, notFound } from './errors.ts'
import { view, type Reader } from './feed.ts'
import type { MessageView } from '../api/routes.ts'
import type { ResolvedTarget } from '../sync/provider.ts'
import type { BoardClient } from '../client/client.ts'
import { runMiddleware, type Middleware, type WriteSource } from './middleware.ts'

/** Who a write is attributed to. */
export type Identity = { principal: Principal; author: Author; actor: Actor }

/** A piece of the board's own deployment, writing as `actor` with full access. */
export function deploymentIdentity(actor: string, handle: string): Identity {
  return {
    principal: { id: actor, kind: 'deployment', handle, access: FULL_ACCESS, expiresAt: null },
    author: { actor, principal: actor, profile: null, session: null },
    actor: { id: actor, kind: 'deployment', handle, name: handle, avatar: null },
  }
}

export type WriteContext = {
  session: BoardSession
  /** The board's tables, where writes check what they write to. */
  reads: BoardReads
  /** External channels a new root in this board channel starts threads in. */
  configTargets: (channel: string) => Promise<ResolvedTarget[]>
  /** Validates a requested target and resolves names (`slack:#prs`) to IDs. */
  normalizeTarget: (target: string) => Promise<ResolvedTarget>
  /** A synced platform's user with this email, for `@[ada@vercel.com]`. */
  findByEmail?: (email: string) => Promise<Actor | null>
  /** Runs on every post and edit, in order, before it lands. */
  middleware?: readonly Middleware[]
  /** The in-process client middleware writes with. */
  middlewareClient?: () => BoardClient
}

/** Where a write came from; `middleware` is the middleware's own client, which skips it. */
export type Via = WriteSource | { kind: 'middleware' }

/** How a write reaches the middleware: where it's from, and how to answer there. */
export type WriteOrigin = { via?: Via; respond?: (text: string) => Promise<void> }

const middlewareFor = (ctx: WriteContext, origin: WriteOrigin) =>
  origin.via?.kind === 'middleware' || !ctx.middleware?.length ? null : ctx.middleware

const sourceOf = (origin: WriteOrigin): WriteSource => (origin.via as WriteSource | undefined) ?? { kind: 'api' }

const middlewareClient = (ctx: WriteContext) => () => {
  if (!ctx.middlewareClient) throw new Error('middleware used before the board bound it')
  return ctx.middlewareClient()
}

/** Each email is a directory lookup on every synced platform, so a write names only a few. */
const EMAIL_MENTIONS_MAX = 10

/**
 * The emails a write looks up. More than `EMAIL_MENTIONS_MAX` fails the write;
 * a lenient one looks up the first few, and the rest stay plain text.
 */
export function emailMentions(text: string, lenient: boolean): string[] {
  const emails = extractMentions(text).flatMap((token) =>
    token.kind === 'actor' && token.actor.includes('@') ? [token.actor] : [],
  )
  if (emails.length > EMAIL_MENTIONS_MAX && !lenient)
    throw badRequest(`a message mentions at most ${EMAIL_MENTIONS_MAX} people by email, this one has ${emails.length}`, 'too_many_email_mentions')
  return emails.slice(0, EMAIL_MENTIONS_MAX)
}

/**
 * `@[ada@vercel.com]`: each email a synced platform knows becomes that user's exact
 * mention, `@[slack:user:U0456]`, so it reads natively there; the rest stay plain text.
 */
async function withEmailMentions(ctx: WriteContext, text: string, lenient: boolean): Promise<{ text: string; found: Actor[] }> {
  const emails = emailMentions(text, lenient)
  if (emails.length === 0) return { text, found: [] }
  const byEmail = new Map<string, Actor | null>()
  for (const email of emails) byEmail.set(email, (await ctx.findByEmail?.(email).catch(() => null)) ?? null)
  return {
    text: replaceMentions(text, (token) => {
      if (token.kind !== 'actor' || !token.actor.includes('@')) return null
      const actor = byEmail.get(token.actor)
      return actor ? `@[${actor.id}]` : token.actor
    }),
    found: [...byEmail.values()].filter((actor) => actor !== null),
  }
}

/** The actors a write can mention: the ones the board knows, plus the ones an email named. */
const knownWith = (actors: ActorsState, found: Actor[]): ActorsState =>
  found.length === 0 ? actors : { ...actors, byId: { ...actors.byId, ...Object.fromEntries(found.map((a) => [a.id, a])) } }

const messageNotFound = (id: number) => () => notFound(`message not found: #${id}`, 'message_not_found')

/**
 * A message the board looked up, and a proof of what the caller may do to it.
 * By-ID writes take one and spend the proof on that message, so they act on
 * what the board found, never on what the request said.
 */
export type Authorized<P extends Permission> = { readonly message: Message; readonly proof: Proof<P> }

/**
 * A message the board looked up and the caller may act on with `permission`,
 * proved against its own channel. A message they can't read answers 404, as if
 * it didn't exist: IDs are sequential, so a 403 would confirm it does.
 */
export async function authorizeMessage<P extends Permission>(
  ctx: WriteContext,
  access: Access,
  permission: P,
  id: number,
): Promise<Authorized<P>> {
  const message = await ctx.reads.message(id)
  if (!message) throw messageNotFound(id)()
  return { message, proof: authorize(access, permission, message.channel, messageNotFound(id)) }
}

/**
 * Your own message, to edit or delete: `post` in its channel. Where you can't
 * read, it's yours only if it was posted without reading too: a write-only
 * source fixes what it wrote, but a principal ID it shares with a caller that
 * reads (a repo's workflows share one) doesn't reach that caller's messages.
 * Someone else's answers 404 where you can't read it, and 403 where you can.
 */
export async function authorizeOwn(
  ctx: WriteContext,
  principal: Principal,
  id: number,
  verb: 'edit' | 'delete',
): Promise<Authorized<'post'>> {
  const message = await ctx.reads.message(id)
  if (!message) throw messageNotFound(id)()
  const readable = principal.access.readable(message.channel)
  if (message.by.principal !== principal.id || (!readable && !message.blind)) {
    if (!readable) throw messageNotFound(id)()
    throw forbidden(`only the author can ${verb} a message`)
  }
  return { message, proof: authorize(principal.access, 'post', message.channel) }
}

/**
 * What a post was proved for: `post` where it lands, and `label` and `sync`
 * when it carries them. A reply's also carry the message it answers, as the
 * board looked it up.
 */
export type PostProofs = { post: Proof<'post'>; label?: Proof<'label'>; sync?: Proof<'sync'>; re?: Message }

const hasLabels = (labels: Labels | undefined) => Object.keys(labels ?? {}).length > 0

/**
 * Proofs for a post. A root lands in the channel it names, which the caller
 * needn't read: write-only is `['post']`. A reply lands in its root's channel,
 * looked up here and never taken from the request, and needs `read` there too,
 * since addressing a thread you can't see would confirm it exists.
 */
export async function authorizePost(
  ctx: WriteContext,
  access: Access,
  input: { channel?: string | undefined; re?: number | undefined; labels?: Labels | undefined; sync?: string[] | undefined },
): Promise<PostProofs> {
  let channel: string
  let re: Message | undefined
  if (input.re !== undefined) {
    re = (await authorizeMessage(ctx, access, 'read', input.re)).message
    channel = re.channel
  } else {
    if (!input.channel) throw badRequest('a post needs a channel')
    channel = input.channel
  }
  return {
    post: authorize(access, 'post', channel),
    ...(re ? { re } : {}),
    ...(hasLabels(input.labels) ? { label: authorize(access, 'label', channel) } : {}),
    ...(input.sync?.length ? { sync: authorize(access, 'sync', channel) } : {}),
  }
}

/**
 * Spends a proof on its target: a write checked against one channel can't land
 * in another. A mismatch is the board's own bug, never the caller's.
 */
function spend(proof: Proof | undefined, permission: Permission, target: { channel: string }) {
  if (!proof || proof.permission !== permission || proof.channel !== target.channel)
    throw new Error(`a ${permission} write in ${target.channel} needs a proof for that channel`)
}

/** Full-access proofs for the board's own code (sync), still checked against the channel each write lands in. */
export const trusted = {
  message: <P extends Permission>(ctx: WriteContext, permission: P, id: number) => authorizeMessage(ctx, FULL_ACCESS, permission, id),
  post: (ctx: WriteContext, input: Parameters<typeof authorizePost>[2]) => authorizePost(ctx, FULL_ACCESS, input),
}

export type PostInput = WriteOrigin & {
  identity: Identity
  /** From `authorizePost`. */
  proofs: PostProofs
  channel?: string | undefined
  re?: number | undefined
  text: string
  labels?: Labels | undefined
  noSync?: boolean | undefined
  id?: string | undefined
  sync?: string[] | undefined
  origin?: Origin | null
  from?: string | null
  /** Platform text: mentions the board can't resolve are left as plain text. */
  lenientMentions?: boolean
  /** Files the board stored, as it recorded them. */
  attachments?: Attachment[]
  /** Platform messages it links to. */
  links?: Link[]
  /** The schedule send that posts it. */
  schedule?: { id: number; n: number }
}

/**
 * A post as it landed. `unknownMentions` lists the handles in it that matched
 * nobody and stayed plain text; it's for the writer, never stored.
 */
export type Posted = MessageView & { unknownMentions?: string[] }

export async function writePost(ctx: WriteContext, input: PostInput): Promise<Posted> {
  const { identity } = input
  const sent = input.text
  let channel = input.channel
  let re: number | null = null
  let replyTo: number | null = null
  let thread: string
  const id = input.id ?? (input.re === undefined ? randomUUID() : undefined)
  if (input.re !== undefined) {
    // The message authorizePost looked up: a reply lands in its thread, never where the request said.
    const target = input.proofs.re
    if (target?.id !== input.re) throw new Error(`a reply to #${input.re} needs proofs for that message`)
    re = target.re ?? target.id
    replyTo = target.id === re ? null : target.id
    channel = target.channel
    thread = target.thread
    if (input.sync?.length)
      throw badRequest('sync attaches whole threads: use `vboard sync <id> <target>`')
  } else {
    if (!channel) throw badRequest('a post needs a channel')
    thread = id!
  }
  spend(input.proofs.post, 'post', { channel })
  if (hasLabels(input.labels)) spend(input.proofs.label, 'label', { channel })
  if (input.sync?.length) spend(input.proofs.sync, 'sync', { channel })

  const chain = middlewareFor(ctx, input)
  if (chain && input.id !== undefined) {
    // A retry of a write that landed (only a caller's own ID can be one): what's on the board stands, whatever the middleware would say now.
    const landed = await ctx.reads.byEventId(input.id)
    if (landed) {
      // Only the same author's post in the same place is a retry. Text and labels can't tell:
      // the middleware may have changed them, and edits may have since.
      if (!sameAuthor(landed.by, identity.author) || landed.channel !== channel || landed.re !== re || landed.replyTo !== replyTo)
        throw duplicateId()
      const { access } = identity.principal
      const { state: actors } = await ctx.session.state(actorsReducer)
      if (access.readable(channel)) return shownTo(view(landed, actors, await readerFor(ctx, access, landed)), access, sent)
      // A caller that can't read gets back what it sent, as it landed: never what others have added since.
      // A post written by a caller that could read isn't its to replay, as `authorizeOwn` holds.
      if (!landed.blind) throw duplicateId()
      const [event] = await ctx.session.history({ gte: landed.id, lte: landed.id })
      const posted = foldMessages({ byId: {}, replies: {} }, event as BoardEvent).byId[landed.id]!
      return shownTo(view(posted, actors, await readerFor(ctx, access, posted)), access, sent)
    }
  }
  if (chain)
    return runMiddleware(
      chain,
      {
        write: { kind: 'post', channel: channel!, re, text: input.text, labels: input.labels ?? {}, attachments: input.attachments ?? [] },
        author: identity.actor,
        source: sourceOf(input),
        board: middlewareClient(ctx),
        ...(input.respond ? { respond: input.respond } : {}),
      },
      (write) => commitPost(ctx, { ...input, text: write.text, labels: write.labels }, { channel: channel!, re, replyTo, thread, id, sent }),
    )
  return commitPost(ctx, input, { channel: channel!, re, replyTo, thread, id, sent })
}

const sameAuthor = (a: Author, b: Author) =>
  a.actor === b.actor && a.principal === b.principal && a.profile === b.profile && a.session === b.session

async function commitPost(
  ctx: WriteContext,
  input: PostInput,
  placed: { channel: string; re: number | null; replyTo: number | null; thread: string; id: string | undefined; sent: string },
) {
  const { identity } = input
  const { channel, re, replyTo, thread, id, sent } = placed
  const { state: actors } = await ctx.session.state(actorsReducer)
  const targets: { target: string; kind: 'channel' | 'thread'; cause: 'config' | 'request' }[] = []
  if (re === null) {
    const originChannel = input.origin ? input.origin.channel ?? channelOf(input.origin.thread) : null
    if (!input.noSync)
      for (const target of await ctx.configTargets(channel!))
        if (target.target !== originChannel) targets.push({ target: target.target, kind: target.kind, cause: 'config' })
    for (const requested of input.sync ?? []) {
      const target = await ctx.normalizeTarget(requested)
      await unclaimed(ctx, target, thread, identity.principal.access)
      if (!targets.some((t) => t.target === target.target)) targets.push({ target: target.target, kind: target.kind, cause: 'request' })
    }
  }

  const seen = actorSeen(identity.actor, actors)
  const { text, found } = await withEmailMentions(ctx, input.text, input.lenientMentions ?? false)
  const named = found.map((actor) => actorSeen(actor, actors)).filter((event) => event !== null)
  const { mentions, unknown } = resolveMentions(
    text,
    knownWith(actors, found),
    seen ? identity.actor : undefined,
    input.lenientMentions ?? false,
    identity.principal.access.readsAll,
  )
  const synced = await Promise.all(
    targets.map(async ({ target, kind, cause }) => ({
      type: 'thread.synced' as const,
      id: await idempotentId('vboard', thread, 'sync', target),
      payload: { thread, target, kind, cause, by: identity.author },
    })),
  )
  const rows = await ctx.session.append(
    ...(seen ? [seen] : []),
    ...named,
    {
      type: 'message.posted',
      ...(id ? { id } : {}),
      payload: {
        channel: channel!,
        text,
        re,
        replyTo,
        thread,
        labels: input.labels ?? {},
        noSync: input.noSync ?? false,
        mentions,
        by: identity.author,
        origin: input.origin ?? null,
        from: input.from ?? null,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.links?.length ? { links: input.links } : {}),
        ...(input.schedule ? { schedule: input.schedule } : {}),
        ...(identity.principal.access.readable(channel!) ? {} : { blind: true as const }),
      },
    },
    ...synced,
  )
  const posted = rows.find((row) => row.type === 'message.posted') as BoardEvent
  await untilApplied(ctx, rows)
  const message = foldMessages({ byId: {}, replies: {} }, posted).byId[posted.index]!
  const known = seen ? { ...actors, byId: { ...actors.byId, [identity.actor.id]: identity.actor } } : actors
  return shownTo(view(message, known, await readerFor(ctx, identity.principal.access, message)), identity.principal.access, sent, unknown)
}

/**
 * A post's view for its writer. One that can't read the channel gets back the
 * text it sent, no mentions, and no `unknownMentions`: the board resolved its
 * handles and emails to actor IDs, which `/actors` doesn't show it, and which
 * handles matched no one would say which ones exist. The board keeps the
 * mentions, so they still notify.
 */
const shownTo = (shown: MessageView, access: Access, sent: string, unknown: string[] = []): Posted =>
  !access.readable(shown.channel)
    ? { ...shown, text: sent, mentions: [] }
    : unknown.length
      ? { ...shown, unknownMentions: unknown }
      : shown

/** The writer, as the reader of the view its write returns. Only a link to a board message needs a lookup. */
const readerFor = (ctx: WriteContext, access: Access, message: Message): Promise<Reader> => ctx.reads.reader(access, [message])

/**
 * Refuses an external thread another board thread is synced with: taking it
 * over would send its replies away from that thread, to a caller who may not
 * read it. A reader of that thread's channel learns which thread it is. It
 * reads the tables once they've applied the whole log, so a sync just made
 * counts.
 */
async function unclaimed(ctx: WriteContext, target: ResolvedTarget, thread: string, access: Access) {
  if (target.kind !== 'thread') return
  await ctx.reads.ensure()
  const owner = await ctx.reads.tables.threadOf(target.target)
  if (owner === null || owner === thread) return
  const synced = await ctx.reads.tables.syncOf(owner)
  const which = synced && access.readable(synced.channel) ? `#${synced.root}` : 'another thread'
  throw new HttpError(409, 'already_synced', `${target.target} is already synced with ${which}`)
}

/** `slack:C0123ABC:1727.1` → `slack:C0123ABC`; `github:o/r:12` → `github:o/r`. */
export const channelOf = (externalThread: string) => {
  const at = externalThread.indexOf(':')
  const rest = externalThread.slice(at + 1)
  const colon = rest.indexOf(':')
  return colon === -1 ? externalThread : externalThread.slice(0, at + 1 + colon)
}

/**
 * Waits until the tables hold a write, so any read after it includes it. Most often
 * nothing was written in between, and the writer applies its own events itself; else
 * it waits for the tables' consumer. The write landed either way: if the tables are
 * slow or stuck, it still succeeds.
 */
async function untilApplied(ctx: WriteContext, rows: readonly { index: number }[]) {
  const events = ([...rows] as unknown as BoardEvent[]).sort((a, b) => a.index - b.index)
  const last = events.at(-1)!.index
  try {
    let caughtUp = true
    for (const event of events) if (!(caughtUp = await ctx.reads.tables.applyNext(event))) break
    if (caughtUp) return
  } catch {
    // The consumer applies them.
  }
  await ctx.reads.ensure(last, AbortSignal.timeout(LANDED_WAIT_MS)).catch((error: unknown) => {
    console.warn(`[vboard] the tables haven't applied #${last} yet:`, (error as Error).message)
  })
}

/** How long a write waits for the tables before it answers anyway. */
const LANDED_WAIT_MS = 10_000

/** The message a by-ID write targets, as the board looked it up, once its proof is spent on the message's channel. */
function spent<P extends Permission>(authorized: Authorized<P>, permission: P): Message {
  spend(authorized.proof, permission, authorized.message)
  return authorized.message
}

export type EditInput = WriteOrigin & {
  identity: Identity
  authorized: Authorized<'post'>
  text: string
  from?: string | null
  asAuthor?: boolean
}

export async function writeEdit(ctx: WriteContext, input: EditInput): Promise<{ unknownMentions?: string[] }> {
  const message = spent(input.authorized, 'post')
  if (input.asAuthor !== false && message.by.principal !== input.identity.principal.id)
    throw forbidden('only the author can edit a message')
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const chain = middlewareFor(ctx, input)
  if (!chain) return commitEdit(ctx, input, message)
  return runMiddleware(
    chain,
    {
      write: { kind: 'edit', id: message.id, channel: message.channel, re: message.re, text: input.text },
      author: input.identity.actor,
      source: sourceOf(input),
      board: middlewareClient(ctx),
      ...(input.respond ? { respond: input.respond } : {}),
    },
    (write) => commitEdit(ctx, { ...input, text: write.text }, message),
  )
}

async function commitEdit(ctx: WriteContext, input: EditInput, message: Message): Promise<{ unknownMentions?: string[] }> {
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = actorSeen(input.identity.actor, actors)
  const { text, found } = await withEmailMentions(ctx, input.text, input.from != null)
  const named = found.map((actor) => actorSeen(actor, actors)).filter((event) => event !== null)
  const { mentions, unknown } = resolveMentions(
    text,
    knownWith(actors, found),
    seen ? input.identity.actor : undefined,
    input.from != null,
    input.identity.principal.access.readsAll,
  )
  const rows = await ctx.session.append(...(seen ? [seen] : []), ...named, {
    type: 'message.edited',
    payload: {
      id: message.id,
      thread: message.thread,
      text,
      mentions,
      by: input.identity.author,
      from: input.from ?? null,
    },
  })
  await untilApplied(ctx, rows)
  // As on a post: which handles matched no one is only for a caller that reads the channel.
  return unknown.length && input.identity.principal.access.readable(message.channel) ? { unknownMentions: unknown } : {}
}

/** A message's links, replaced: a platform edit or unfurl changed what it links to. */
export async function writeLinks(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'post'>; links: Link[]; from: string | null },
) {
  const message = spent(input.authorized, 'post')
  if (message.deleted) return
  await untilApplied(ctx, await ctx.session.append({
    type: 'message.linked',
    payload: { id: message.id, thread: message.thread, links: input.links, by: input.identity.author, from: input.from },
  }))
}

export async function writeDelete(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'post'>; from?: string | null; asAuthor?: boolean },
) {
  const message = spent(input.authorized, 'post')
  if (input.asAuthor !== false && message.by.principal !== input.identity.principal.id)
    throw forbidden('only the author can delete a message')
  if (message.deleted) return
  await untilApplied(ctx, await ctx.session.append({
    type: 'message.deleted',
    payload: { id: message.id, thread: message.thread, by: input.identity.author, from: input.from ?? null },
  }))
}

export async function writeReaction(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'react'>; emoji: string; remove?: boolean; from?: string | null },
) {
  const message = spent(input.authorized, 'react')
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = actorSeen(input.identity.actor, actors)
  await untilApplied(ctx, await ctx.session.append(...(seen ? [seen] : []), {
    type: input.remove ? 'reaction.removed' : 'reaction.added',
    payload: {
      id: message.id,
      thread: message.thread,
      emoji: input.emoji,
      by: input.identity.author,
      from: input.from ?? null,
    },
  }))
}

export async function writeLabels(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'label'>; set?: Labels | undefined; unset?: string[] | undefined },
) {
  const message = spent(input.authorized, 'label')
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = actorSeen(input.identity.actor, actors)
  await untilApplied(ctx, await ctx.session.append(...(seen ? [seen] : []), {
    type: 'labels.changed',
    payload: {
      id: message.id,
      thread: message.thread,
      set: input.set ?? {},
      unset: input.unset ?? [],
      by: input.identity.author,
    },
  }))
}

/** Attaches a thread to an external target. Attaching twice is a no-op; a thread another one is synced with is a 409. */
export async function writeAttach(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'sync'>; target: string },
) {
  const message = spent(input.authorized, 'sync')
  const resolved = await ctx.normalizeTarget(input.target)
  const { target, kind } = resolved
  if ((await ctx.reads.tables.syncOf(message.thread))?.targets.includes(target)) return { target, attached: false }
  await unclaimed(ctx, resolved, message.thread, input.identity.principal.access)
  // Applied before it answers, so replies from the platform thread find it at once.
  await untilApplied(ctx, await ctx.session.append({
    type: 'thread.synced',
    id: await idempotentId('vboard', message.thread, 'sync', target),
    payload: { thread: message.thread, target, kind, cause: 'request', by: input.identity.author },
  }))
  return { target, attached: true }
}
