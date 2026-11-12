import { INBOX_EVENT_ID_MAX, type Explanation, type GrantView, type Me, type MessageView, type RegistrationView } from '../api/routes.ts'
import { BoardError, type ExplainPrincipal } from '../client/client.ts'
import { block } from '../contract/blocks.ts'
import { canonical } from '../contract/data-schemas.ts'
import { canText, compileAccess, type Permission } from '../server/access.ts'
import type { Board } from '../server/board.ts'

/**
 * Checks that a board speaks the protocol, through a handle on it (`conformance(board())`), as
 * `vb` and agents use it: every board answers all of it. A board may keep no schedules or files,
 * and says so with a 501, which the kit reports as not kept here. It writes to one channel
 * (`conformance` by default), keeps every post on the board, and deletes what it posted. The one
 * schema it registers, `conformance@1`, stays: a schema version is never removed.
 */

/** What a check is about, for the report's headings. */
export type CheckGroup = 'core' | 'schedules' | 'grants' | 'schemas' | 'attachments' | 'watchers' | 'sync'

export type CheckResult = {
  group: CheckGroup
  name: string
  status: 'passed' | 'failed' | 'skipped'
  /** Why it failed, or why it was skipped: `not kept here: …` for what the board answers 501 to. */
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
  /**
   * The same board, with this run's credential and an `x-board-can` header that narrows it to
   * `can` (`conformance=read`), as a proxy holding the credential sends it: the checks of a
   * narrowed caller call it so. Without it, they're skipped.
   */
  withCan?: (can: string) => Board
  /**
   * The same board, with this run's credential and `headers` on every request, as a client or a proxy
   * holding the credential sends them: the checks of who writes call it so, with an
   * `x-board-profile` that carries an avatar and the headers that one replaced. Without it, they're
   * skipped, and it stands in for `withCan` when that's left out.
   */
  withHeaders?: (headers: Record<string, string>) => Board
  /**
   * Whom the grants checks name. A board that verifies tokens itself (`vb serve`) takes the made-up
   * IDs they use without it; one that looks names up, as Vercel's API does, needs real ones on its
   * team, or skips the checks that name them: a `project` (its name or ID), a GitHub `repository`
   * no grant names, a `viewer` (a person's email or ID whose team role is viewer), to check
   * that a role caps what grants give, and an `app` installed on the board's team (its slug or
   * client ID), which a local board has none of. Checks that grant to someone besides the project
   * name the app when there's one, and the repository otherwise: Vercel's board takes no GitHub
   * principal in a grant, so give it an app. None may be the run's own: it throws before it
   * writes.
   */
  principals?: { project?: string; repository?: string; viewer?: string; app?: string }
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

/** That `attempt` is refused with `status`, whatever code the board gives it. */
async function refused(attempt: Promise<unknown>, status: number, what: string) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof BoardError && error.status === status) return
    throw new Mismatch(`${what}: expected ${status}, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
  throw new Mismatch(`${what}: expected ${status}, and it succeeded`)
}

const NO_CAN = "this run can't call the board with an x-board-can header"
const NO_HEADERS = "this run can't call the board with headers of its own"

/** The avatar the checks of who writes give their profile. */
const AVATAR = 'https://example.com/conformance.png'

/** A post by `poster`, which sends `header`, read back as the run sees it: it lands, and is deleted when the run ends. */
async function postedWith(ctx: Context, poster: Board, header: string) {
  const posted = await poster.post(ctx.channel, { text: `conformance: with ${header}`, labels: ctx.labels, noSync: true }).catch((error: unknown) => {
    throw new Mismatch(`a post with ${header}, which released clients still send: expected it to land, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  })
  ctx.posted.push(posted.id)
  return (await ctx.board.thread(posted.id)).message
}

/** That a view's `by` names who wrote it as the protocol has it: an actor, a principal, and a profile, and no session. */
function noSession(by: unknown, what: string) {
  check(typeof by === 'object' && by !== null, `${what} should have a by, got ${show(by)}`)
  check(!('session' in by), `${what} should carry no session, got ${show(by)}`)
}

/**
 * That `attempt`, by a caller narrowed with `x-board-can`, is refused as one: 403 `forbidden`.
 * Vercel's API's refusal of a person's watchers goes on as it is, for the run to skip.
 */
async function narrowedOut(attempt: Promise<unknown>, what: string) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof BoardError && error.code === 'watchers_need_project') throw error
    if (error instanceof BoardError && error.status === 403 && error.code === 'forbidden') return
    throw new Mismatch(`${what}, by a caller narrowed with x-board-can: expected 403 forbidden, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
  }
  throw new Mismatch(`${what}, by a caller narrowed with x-board-can: expected 403 forbidden, and it succeeded`)
}

/** Where a registration is woken, to put back after a check replaces it: its path (and branch) on a board that wakes by path, or nowhere. */
function wokenAt(registered: RegistrationView | undefined): { path?: undefined } | { path: string; branch?: string } {
  if (!registered?.path) return {}
  return { path: registered.path, ...(registered.branch ? { branch: registered.branch } : {}) }
}

/** An ID or cursor as the protocol shapes them: a string of 1 to 128 characters. */
function isRef(value: unknown, what: string) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 128, `${what} should be a string of 1 to 128 characters, got ${show(value)}`)
}

type Context = {
  board: Board
  channel: string
  /** Every post carries it, so reads see this run's messages only. */
  labels: { conformance: string }
  /** The board's position before this run wrote anything. */
  start: string
  me: Me
  root?: MessageView
  reply?: MessageView
  posted: string[]
  withCan?: (can: string) => Board
  withHeaders?: (headers: Record<string, string>) => Board
  principals: Principals
  /** The board's own Vercel team, as its discovery names it. */
  team: string | null
}

type Check = { group: CheckResult['group']; name: string; run: (ctx: Context) => Promise<void | string> }

/**
 * The groups a board may keep none of, saying so with a 501: a board without a scheduler answers
 * `no_scheduler`, and without a blob store `no_files`; a backend of one's own that keeps no grants
 * answers `no_grants`, and one that keeps no schemas `no_schemas`. A board that's meant to keep something and doesn't yet answers otherwise,
 * and fails.
 */
const OPTIONAL = new Set<CheckGroup>(['schedules', 'grants', 'schemas', 'attachments'])

const needRoot = (ctx: Context) => {
  check(ctx.root && ctx.reply, "posting failed, so there's nothing to read")
  return { root: ctx.root, reply: ctx.reply }
}

/**
 * Who the grants checks name: `principals`' own, or made-up IDs, which a board that verifies tokens
 * itself takes. A grant naming them lets nobody in.
 */
type Principals = { project: string; repository: string; viewer: string | null; app: string | null }

/** A check's project, in its environments. */
const projectFor = (ctx: Context, environments = ['preview']) => ({ kind: 'project' as const, project: ctx.principals.project, environments })

/**
 * The subtree every grant the grants checks make sits in, `conformance/grants/`, and every channel
 * they ask about: the same for every run, so a run leaves no channel behind, and no grant reaches
 * outside it. Two runs on one board at once see each other's grants there.
 */
const subtreeOf = (ctx: Context) => `${ctx.channel}/grants/`

/** The check's grant: that project may post in the subtree's `ci/`. */
const grantFor = (ctx: Context) => ({ principals: [projectFor(ctx)], can: { [`${subtreeOf(ctx)}ci/`]: ['post'] } }) as const

/**
 * Whom the checks that grant to someone besides the project name: the app the run was given, or
 * else the repository, which a board that takes no GitHub principal in a grant refuses (Vercel's).
 */
const granteeOf = (ctx: Context) =>
  ctx.principals.app !== null ? ({ kind: 'app', app: ctx.principals.app } as const) : ({ kind: 'github', repository: ctx.principals.repository } as const)

/** A check that can't run here, and why: it's skipped, not failed. */
class Skip extends Error {}

/** A board that looks names up and has none for one a check named: what to pass instead. */
function unnamed(error: unknown): Skip | null {
  if (!(error instanceof BoardError) || error.status !== 400 || !error.code.endsWith('_not_found')) return null
  return new Skip(`this board looks names up and found none for one the check named (${error.message}): pass principals that are real on its team`)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type GrantInput = Parameters<Board['createGrant']>[0]

/** What a grants check makes things with: each is revoked when it ends, whatever happens. */
type Grants = {
  /** Makes a grant, as this run or as `by`. The first this run makes tells whether it may change grants here at all: a 403 skips the check. */
  make(input: GrantInput, by?: Board): Promise<GrantView>
  /** That `by` is refused a grant, with a 403: one a board wrongly makes is revoked too. */
  deny(by: Board, input: GrantInput, what: string): Promise<void>
  /** This run, narrowed with `x-board-can` to `can`: a run that can't send one skips the check. */
  narrow(can: Record<string, 'all' | readonly Permission[]>): Board
  /**
   * A grant that keeps this run in `pattern` with `manage`, so it can lift an `everyone` grant
   * there, which would narrow it too: its user, or its project in its environment.
   */
  keep(pattern: string): Promise<void>
}

/**
 * Runs `check` with what it makes grants with, and revokes them all afterwards, the
 * newest grant first, so one that closes a pattern goes while the one keeping this run in is there.
 * A revoke that fails fails the check: what it made would stay on the board.
 */
async function withGrants(ctx: Context, check: (grants: Grants) => Promise<void | string>): Promise<void | string> {
  const made: string[] = []
  const grants: Grants = {
    async make(input, by) {
      try {
        const { grant } = await (by ?? ctx.board).createGrant(input)
        made.push(grant.id)
        return grant
      } catch (error) {
        if (!by && made.length === 0 && error instanceof BoardError && error.status === 403) throw new Skip("this token can't change the board's grants")
        throw unnamed(error) ?? error
      }
    },
    async deny(by, input, what) {
      try {
        const { grant } = await by.createGrant(input)
        made.push(grant.id)
      } catch (error) {
        if (error instanceof BoardError && error.status === 403) return
        // A board that takes none of these principals skips the check, as below.
        if (error instanceof BoardError && error.code === 'unsupported_principal') throw error
        throw unnamed(error) ?? new Mismatch(`${what}: expected 403, got ${error instanceof BoardError ? `${error.status} ${error.code}` : messageOf(error)}`)
      }
      throw new Mismatch(`${what}: expected 403, and it made the grant`)
    },
    narrow(can) {
      if (!ctx.withCan) throw new Skip(NO_CAN)
      return ctx.withCan(canText(compileAccess(can)))
    },
    async keep(pattern) {
      const [source, kind, id, environment] = ctx.me.principal.split(':')
      if (source === 'board') return
      const self =
        ctx.me.kind === 'person'
          ? { kind: 'user' as const, userId: ctx.me.principal.split(':').slice(2).join(':') }
          : kind === 'project' && id && environment
            ? { kind: 'project' as const, project: id, environments: [environment] }
            : kind === 'app' && id
              ? { kind: 'app' as const, app: id }
              : null
      if (!self) throw new Skip("closing a pattern to everyone would close it to this run too, which no grant could keep in: it's neither a person, a project, nor an app")
      await grants.make({ principals: [self], can: { [pattern]: 'all' } })
    },
  }
  let result: void | string = undefined
  let failure: unknown = null
  try {
    result = await check(grants)
  } catch (error) {
    if (error instanceof Skip) result = error.message
    else failure = error
  }
  const left: string[] = []
  for (const id of made.reverse())
    await ctx.board.revokeGrant(id).catch((error: unknown) => {
      left.push(`${id} (${messageOf(error)})`)
    })
  if (left.length > 0) throw new Mismatch(`${failure ? `${messageOf(failure)}; and it ` : ''}couldn't revoke what it made: ${left.join(', ')}`)
  if (failure) throw failure
  return result
}

/** What decides `channel` for `principal` (the caller, without one), or a skip where the board can't find it by name. */
async function explain(ctx: Context, channel: string, principal?: ExplainPrincipal): Promise<Explanation> {
  try {
    return await ctx.board.explain(channel, principal)
  } catch (error) {
    throw unnamed(error) ?? error
  }
}

const sortedOf = (values: readonly string[] | undefined) => [...(values ?? [])].sort()

/** That `actual` shows as `expected` does: a value compared as JSON, shown once when it isn't. */
function alike(actual: unknown, expected: unknown, what: string) {
  if (show(actual) !== show(expected)) throw new Mismatch(`${what}: expected ${show(expected)}, got ${show(actual)}`)
}

/**
 * The schema the schemas checks register: the same on every run, since a version never changes and
 * is never removed, so a board holds one however often it's checked. A change to it is a new
 * version here, never an edit: a board checked before would refuse this one as another definition.
 * It names every property it requires and gives each keyword its type, as the strictest board asks.
 */
const SCHEMA = {
  name: 'conformance',
  version: 1,
  description: 'What the conformance kit registers, once on every board it checks.',
  schema: {
    type: 'object',
    required: ['run', 'outcome'],
    additionalProperties: false,
    properties: {
      run: { type: 'string', minLength: 1, maxLength: 64 },
      outcome: { enum: ['passed', 'failed'] },
      checks: { type: 'array', maxItems: 500, items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, skipped: { type: 'boolean' } } } },
    },
  },
} as const

/** `SCHEMA`'s definition, saying the same with its keys the other way around. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)])) : value

/** Registers `SCHEMA`, or says why this run can't: a caller without manage at `*` is refused, and the check skipped. */
async function register(ctx: Context): Promise<{ made: Awaited<ReturnType<Board['createSchema']>> } | { skip: string }> {
  try {
    return { made: await ctx.board.createSchema(SCHEMA) }
  } catch (error) {
    if (error instanceof BoardError && error.status === 403) return { skip: "this token can't register schemas" }
    throw error
  }
}

/** The sync key the sync checks register, a platform of their own, so nothing reaches a real one. */
const SYNC_KEY = 'conformance'

/**
 * Registers a sync on `SYNC_KEY` for a check, and says where to put the token's registration back
 * after: or why it can't, since registering replaces the token's watchers.
 */
async function registerSync(ctx: Context): Promise<{ where: ReturnType<typeof wokenAt> } | { skip: string }> {
  const registered = (await ctx.board.watchers()).find((registration) => registration.owner === ctx.me.principal)
  if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
    return { skip: 'this token has watchers or a sync registered here, which registering would replace' }
  const where = wokenAt(registered)
  try {
    await ctx.board.register({ watch: {}, sync: [{ key: SYNC_KEY, platform: SYNC_KEY }] })
  } catch (error) {
    if (error instanceof BoardError && error.status === 403) return { skip: "this token can't register a sync here" }
    throw error
  }
  return { where }
}

async function post(ctx: Context, text: string, extra: { id?: string; attachments?: string[] } = {}) {
  const message = await ctx.board.post(ctx.channel, { text, labels: ctx.labels, noSync: true, ...extra })
  ctx.posted.push(message.id)
  return message
}

async function reply(ctx: Context, re: string, text: string, extra: { after?: string } = {}) {
  const message = await ctx.board.reply(re, { text, noSync: true, ...extra })
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
    name: "replies after a message only while it's the thread's newest, one of any that race",
    run: async (ctx) => {
      // A thread of its own, so the other checks' counts stay as they are.
      const root = await post(ctx, 'conformance: a thread to reply after')
      const first = await reply(ctx, root.id, 'conformance: after the root', { after: root.id })
      await rejects(reply(ctx, root.id, 'conformance: late', { after: root.id }), 409, 'newer_message', 'a reply after the root, once another came after it')
      same((await ctx.board.thread(root.id)).replies.length, 1, 'the replies after a refused one')
      // One that's since been deleted came after it all the same.
      const deleted = await reply(ctx, root.id, 'conformance: deleted', { after: first.id })
      await ctx.board.delete(deleted.id)
      await rejects(reply(ctx, root.id, 'conformance: after a deleted one', { after: first.id }), 409, 'newer_message', 'a reply after a message a deleted one came after')
      // Racing after the same message, one lands and the rest are refused.
      const racing = await Promise.allSettled([1, 2, 3].map((n) => reply(ctx, root.id, `conformance: racing ${n}`, { after: deleted.id })))
      const landed = racing.filter((result) => result.status === 'fulfilled')
      same(landed.length, 1, 'the replies that landed of three racing after the same message')
      for (const result of racing) {
        if (result.status === 'fulfilled') continue
        const error = result.reason as unknown
        check(error instanceof BoardError && error.status === 409 && error.code === 'newer_message', `a reply that lost the race should be 409 newer_message, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      same((await ctx.board.thread(root.id)).replies.length, 3, 'the replies after the race, a deleted one included')
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
    name: 'labels a message only while its labels are as the write says, one of any that race',
    run: async (ctx) => {
      // A message of its own, so the other checks' labels stay as they are.
      const message = await post(ctx, 'conformance: a message to claim')
      const labels = async () => (await ctx.board.thread(message.id)).message.labels
      // Three claim it at once, where no one has: one lands.
      const racing = await Promise.allSettled([1, 2, 3].map((n) => ctx.board.label(message.id, { set: { owner: `agent-${n}` }, if: { owner: null } })))
      const landed = racing.flatMap((result, n) => (result.status === 'fulfilled' ? [`agent-${n + 1}`] : []))
      same(landed.length, 1, 'the claims that landed of three racing where no one had one')
      for (const result of racing) {
        if (result.status === 'fulfilled') continue
        const error = result.reason as unknown
        check(error instanceof BoardError && error.status === 409 && error.code === 'label_conflict', `a claim that lost the race should be 409 label_conflict, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      same((await labels()).owner, landed[0], 'the owner, after the race')
      // From a value it doesn't have, nothing changes.
      await rejects(ctx.board.label(message.id, { set: { owner: 'someone' }, if: { owner: 'no-one' } }), 409, 'label_conflict', "a label write from a value the label doesn't have")
      same((await labels()).owner, landed[0], 'the owner, after a write from the wrong value')
      // From the one it has, it lands.
      await ctx.board.label(message.id, { unset: ['owner'], if: { owner: landed[0]! } })
      same((await labels()).owner, undefined, 'the owner, released from the value it had')
    },
  },
  {
    group: 'core',
    name: 'edits and deletes a message only at the revision it was read at, which only edits and deletes change',
    run: async (ctx) => {
      // A message of its own, so the other checks' text stays as it is.
      const message = await post(ctx, 'conformance: a message to edit')
      const read = async () => (await ctx.board.thread(message.id)).message
      const first = (await read()).revision
      check(typeof first === 'number', `a message's revision should be a number, got ${show(first)}`)
      await ctx.board.react(message.id, 'eyes')
      await ctx.board.label(message.id, { set: { state: 'open' } })
      same((await read()).revision, first, 'the revision after a reaction and a label')
      await ctx.board.edit(message.id, 'conformance: edited', { revision: first })
      const second = (await read()).revision
      check(second !== first, `an edit should change the revision from ${first}`)
      await rejects(ctx.board.edit(message.id, 'conformance: stale', { revision: first }), 409, 'revision_conflict', 'an edit at a revision an edit came after')
      await rejects(ctx.board.delete(message.id, { revision: first }), 409, 'revision_conflict', 'a delete at a revision an edit came after')
      const after = await read()
      check(after.text === 'conformance: edited' && !after.deleted, `refused writes should leave it as it was, got ${show({ text: after.text, deleted: after.deleted })}`)
      // Racing at the same revision, one lands and the rest are refused.
      const racing = await Promise.allSettled([1, 2, 3].map((n) => ctx.board.edit(message.id, `conformance: racing ${n}`, { revision: second })))
      same(racing.filter((result) => result.status === 'fulfilled').length, 1, 'the edits that landed of three racing at the same revision')
      for (const result of racing) {
        if (result.status === 'fulfilled') continue
        const error = result.reason as unknown
        check(error instanceof BoardError && error.status === 409 && error.code === 'revision_conflict', `an edit that lost the race should be 409 revision_conflict, got ${error instanceof BoardError ? `${error.status} ${error.code}` : String(error)}`)
      }
      const last = (await read()).revision
      await ctx.board.delete(message.id, { revision: last })
      check((await read()).deleted, 'a delete at the revision it has should delete it')
      // Read before the delete, an edit learns it changed since, not that it's gone.
      await rejects(ctx.board.edit(message.id, 'conformance: too late', { revision: last }), 409, 'revision_conflict', 'an edit at a revision a delete came after')
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
    name: "matches text anywhere in a message's own, in any case, as it reads now",
    run: async (ctx) => {
      // Roots of its own: the second matches the first's searches only where % or _ is a wildcard.
      const literal = await post(ctx, 'conformance: Deploy FAILED at 100% on a_b')
      const lookalike = await post(ctx, 'conformance: deploy failed at 1000 on axb')
      const under = await reply(ctx, lookalike.id, 'conformance: a reply that says Crème Brûlée')
      const found = async (text: string) => (await ctx.board.messages({ channel: ctx.channel, label: ctx.labels, after: ctx.start, text })).messages.map((m) => m.id)
      alike(await found('DEPLOY failed'), [literal.id, lookalike.id], 'the messages "DEPLOY failed" finds')
      alike(await found('100%'), [literal.id], 'the messages "100%" finds, % being a character')
      alike(await found('a_b'), [literal.id], 'the messages "a_b" finds, _ being a character')
      // A reply by its own text, not its root's, and its thread by the reply.
      alike(await found('BRÛLÉE'), [under.id], 'the messages "BRÛLÉE" finds')
      const { threads } = await ctx.board.threads({ channel: ctx.channel, label: ctx.labels, text: 'crème brûlée' })
      alike(threads.map((t) => t.message.id), [lookalike.id], 'the threads "crème brûlée" finds')
      // An edit changes what finds it.
      await ctx.board.edit(lookalike.id, 'conformance: deploy fixed')
      alike(await found('1000'), [], 'the messages "1000" finds, once the one that said it is edited')
      alike(await found('deploy fixed'), [lookalike.id], 'the messages "deploy fixed" finds, once one is edited to say it')
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
    // Labels are state agents read: a deleted task mustn't still look open.
    name: 'drops a deleted message from what its labels find',
    run: async (ctx) => {
      const label = { ...ctx.labels, tombstone: ctx.labels.conformance }
      const root = await ctx.board.post(ctx.channel, { text: 'conformance: a labeled root to delete', labels: label, noSync: true })
      ctx.posted.push(root.id)
      const kept = await reply(ctx, root.id, 'conformance: a reply under it')
      const found = async () => ({
        threads: (await ctx.board.threads({ channel: ctx.channel, label })).threads.map((t) => t.message.id),
        messages: (await ctx.board.messages({ channel: ctx.channel, label })).messages.map((m) => m.id),
      })
      const before = await found()
      check(before.threads.includes(root.id) && before.messages.includes(kept.id), `its labels should find the root and its reply before the delete, got ${show(before)}`)
      await ctx.board.delete(root.id)
      const { labels } = (await ctx.board.thread(root.id)).message
      check(Object.keys(labels).length === 0, `a deleted message should keep no labels, got ${show(labels)}`)
      const after = await found()
      check(!after.threads.includes(root.id), `a label read should leave out a deleted root's thread, got ${show(after.threads)}`)
      check(!after.messages.includes(root.id) && !after.messages.includes(kept.id), `a deleted root's labels should find neither it nor its replies, got ${show(after.messages)}`)
    },
  },
  {
    group: 'core',
    // A watcher tailing a label must learn its message is gone, though the tombstone wears none.
    name: "tells a label's feed when a message it found is deleted",
    run: async (ctx) => {
      const label = { ...ctx.labels, deleting: ctx.labels.conformance }
      const root = await ctx.board.post(ctx.channel, { text: 'conformance: a labeled root whose thread is deleted', labels: label, noSync: true })
      ctx.posted.push(root.id)
      const under = await reply(ctx, root.id, 'conformance: a reply its label finds')
      const { cursor } = await ctx.board.poll({ channel: ctx.channel, label })
      await ctx.board.delete(under.id)
      await ctx.board.delete(root.id)
      const { events } = await ctx.board.poll({ channel: ctx.channel, label, after: cursor })
      const deleted = events.filter((event) => event.type === 'message.deleted').map((event) => event.message?.id)
      check(deleted.includes(under.id), `a label's feed should get the deletion of a reply its root's label found, got ${show(events.map((event) => event.type))}`)
      check(deleted.includes(root.id), `a label's feed should get the deletion of a message that wore the label, got ${show(events.map((event) => event.type))}`)
    },
  },
  {
    group: 'core',
    name: 'lists the channel and you in it',
    run: async (ctx) => {
      const channels = await ctx.board.channels()
      const found = channels.find((c) => c.path === ctx.channel)
      check(found, `the channels should include ${ctx.channel}`)
      // A board counts what it keeps, and leaves out what it doesn't: Vercel's API keeps no counts.
      for (const field of ['lastIndex', 'messages', 'threads'] as const)
        check(found[field] === undefined || typeof found[field] === 'number', `a channel's ${field} should be a number or left out, got ${show(found[field])}`)
      const actors = await ctx.board.actors()
      check(actors.some((a) => a.id === ctx.me.actor), `the actors should include ${ctx.me.actor}`)
    },
  },
  {
    group: 'core',
    // It makes none of its own: a board keeps every channel, and a run leaves nothing behind.
    name: 'creates a channel only once: one a post made is there already',
    run: async (ctx) => {
      needRoot(ctx)
      const { channel, created } = await ctx.board.createChannel(ctx.channel)
      same(created, false, `creating ${ctx.channel}, which this run posted to`)
      same(channel.path, ctx.channel, "the channel's path")
      await rejects(ctx.board.createChannel('Not A Channel'), 400, 'invalid_request', 'creating a malformed channel')
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
    group: 'core',
    name: 'narrows a caller to what its x-board-can says',
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const { root } = needRoot(ctx)
      const narrowed = ctx.withCan(`${ctx.channel}=read`)
      const me = await narrowed.me()
      same(me.principal, ctx.me.principal, "a narrowed caller's principal, its own")
      alike(me.can, { [ctx.channel]: ['read'] }, 'what a caller narrowed to read says it may do')
      same((await narrowed.thread(root.id)).message.id, root.id, 'a thread read by a caller narrowed to read it')
      const posting = narrowed.post(ctx.channel, { text: 'conformance: narrowed to read', labels: ctx.labels, noSync: true }).then((message) => {
        ctx.posted.push(message.id)
        return message
      })
      await refused(posting, 403, 'a post by a caller narrowed to read')
    },
  },
  {
    group: 'core',
    name: 'takes a profile and its avatar as one x-board-profile header, and shows both on what it writes',
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      const name = `conformance-${ctx.labels.conformance}`
      const agent = ctx.withHeaders({ 'x-board-profile': `${name}; avatar="${AVATAR}"` })
      const posted = await agent.post(ctx.channel, { text: 'conformance: as a profile, with its avatar', labels: ctx.labels, noSync: true })
      ctx.posted.push(posted.id)
      const { message } = await ctx.board.thread(posted.id)
      same(message.by.principal, ctx.me.principal, "the profile's principal, this run's")
      same(message.by.profile?.toLowerCase(), name, 'the profile its header names')
      same(message.author?.kind, 'agent', "the profile's kind")
      same(message.author?.name, name, "the profile's name")
      same(message.author?.avatar, AVATAR, "the profile's avatar, from its header's parameter")
    },
  },
  {
    group: 'core',
    name: 'lets a profile change only its own messages, and its principal all of them',
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      if (ctx.me.actor !== ctx.me.principal) return "this run writes as a profile, so it can't change messages as its principal"
      const as = (name: string) => ctx.withHeaders!({ 'x-board-profile': `conformance-${name}-${ctx.labels.conformance}` })
      const by = async (poster: Board, text: string) => {
        const message = await poster.post(ctx.channel, { text, labels: ctx.labels, noSync: true })
        ctx.posted.push(message.id)
        return message
      }
      const profile = as('own')
      const own = await by(profile, "conformance: a profile's own")
      const other = await by(as('other'), "conformance: another profile's")
      const principal = await by(ctx.board, "conformance: its principal's")
      await profile.edit(own.id, "conformance: a profile's own, edited by it")
      same((await ctx.board.thread(own.id)).message.text, "conformance: a profile's own, edited by it", "a profile's own message, once it edits it")
      for (const [message, whose] of [[other, "another profile's"], [principal, "its principal's"]] as const) {
        await refused(profile.edit(message.id, 'conformance: not its own'), 403, `an edit, by a profile, of ${whose} message`)
        await refused(profile.delete(message.id), 403, `a delete, by a profile, of ${whose} message`)
      }
      await ctx.board.edit(other.id, "conformance: another profile's, edited by its principal")
      const edited = (await ctx.board.thread(other.id)).message
      same(edited.text, "conformance: another profile's, edited by its principal", "a profile's message, once its principal edits it")
      same(edited.by.actor, other.by.actor, "who a profile's message is by, once its principal edits it")
      for (const message of [own, other]) {
        await ctx.board.delete(message.id)
        check((await ctx.board.thread(message.id)).message.deleted, "a profile's message, once its principal deletes it, should be deleted")
      }
      await profile.delete((await by(profile, "conformance: a profile's own, to delete")).id)
    },
  },
  {
    group: 'core',
    name: "ignores x-board-avatar, which x-board-profile's avatar parameter replaced",
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      // A profile of its own: the one the check before gave an avatar would show it still.
      const name = `conformance-bare-${ctx.labels.conformance}`
      const message = await postedWith(ctx, ctx.withHeaders({ 'x-board-profile': name, 'x-board-avatar': AVATAR }), 'x-board-avatar')
      same(message.by.profile?.toLowerCase(), name, 'the profile its header names')
      same(message.author?.avatar ?? null, null, "the avatar of a profile whose header names none, whatever x-board-avatar says")
    },
  },
  {
    group: 'core',
    name: 'ignores x-board-session: who writes is the principal and its profile',
    run: async (ctx) => {
      if (!ctx.withHeaders) return NO_HEADERS
      const message = await postedWith(ctx, ctx.withHeaders({ 'x-board-session': `conformance-${ctx.labels.conformance}` }), 'x-board-session')
      same(message.by.actor, ctx.me.actor, 'who a post with x-board-session is by: this run, as itself')
      noSession(message.by, 'a post with x-board-session')
    },
  },
  {
    group: 'core',
    name: 'shows no session on a message, its event, or you',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      noSession((await ctx.board.thread(root.id)).message.by, 'a message')
      const { events } = await ctx.board.poll({ channel: ctx.channel, after: ctx.start, label: ctx.labels, wait: 0 })
      const posted = events.find((event) => event.type === 'message.posted')
      check(posted !== undefined, `events after the run's start should hold its post, got ${show(events.map((event) => event.type))}`)
      noSession((posted.payload as { by?: unknown }).by, "a message.posted event's payload")
      check(!('session' in ctx.me), `you should carry no session, got ${show(ctx.me)}`)
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
    group: 'schedules',
    name: 'keeps noSync on a schedule, so its sends stay off every platform',
    run: async (ctx) => {
      const { root } = needRoot(ctx)
      const schedule = await ctx.board.schedule({ re: root.id }, { text: 'conformance: later, on the board only', noSync: true, in: '1d' })
      try {
        same(schedule.noSync, true, "the schedule's noSync")
        same((await ctx.board.schedules({ re: root.id })).find((s) => s.id === schedule.id)?.noSync, true, "the listed schedule's noSync")
      } finally {
        await ctx.board.cancelSchedule(schedule.id).catch(() => {})
      }
    },
  },
  {
    group: 'grants',
    name: 'grants a principal, lists it, and revokes it',
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const grant = await make(grantFor(ctx))
        isRef(grant.id, "a grant's id")
        const [project] = grant.principals
        check(
          grant.principals.length === 1 && project?.kind === 'project' && (project.projectId === ctx.principals.project || project.name === ctx.principals.project),
          `the grant's principals: expected the project ${ctx.principals.project}, got ${show(grant.principals)}`,
        )
        alike(project.environments, ['preview'], "the project's environments")
        alike(grant.can, { [`${subtreeOf(ctx)}ci/`]: ['post'] }, "the grant's can")
        same((await ctx.board.grants()).filter((listed) => listed.id === grant.id).length, 1, 'grants listing it')
        same((await ctx.board.revokeGrant(grant.id)).revoked, true, 'revoking it')
        same((await ctx.board.revokeGrant(grant.id)).revoked, false, 'revoking it again')
        check(!(await ctx.board.grants()).some((listed) => listed.id === grant.id), "grants shouldn't list it once it's revoked")
      }),
  },
  {
    group: 'grants',
    name: 'makes another grant for the same principals, and changes one by its ID',
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const first = await make(grantFor(ctx))
        const again = await make(grantFor(ctx))
        check(again.id !== first.id, `the same principals again should be another grant, got ${again.id} twice`)
        const other = granteeOf(ctx)
        const ci = `${subtreeOf(ctx)}ci/`
        // A board that looks names up and has none for the app or repository skips the rest.
        const update = async (change: Parameters<Board['updateGrant']>[1]) => {
          try {
            return await ctx.board.updateGrant(first.id, change)
          } catch (error) {
            throw unnamed(error) ?? error
          }
        }
        // The project again joins the one it names: its environments together.
        const added = await update({ add: [other, projectFor(ctx, ['production'])], can: { [ci]: ['read', 'post'] } })
        same(added.grant.id, first.id, "the updated grant's id")
        alike(added.grant.principals.map((principal) => principal.kind), ['project', other.kind], `principals after adding ${other.kind === 'app' ? 'an app' : 'a repository'}, and the project again`)
        const project = added.grant.principals[0]
        alike(sortedOf(project?.kind === 'project' ? project.environments : undefined), sortedOf(['preview', 'production']), "the project's environments, after adding it again")
        alike(added.grant.can, { [ci]: ['read', 'post'] }, "the updated grant's can")
        // A project to remove is the project, whatever its environments.
        const removed = await update({ remove: [{ kind: 'project', project: ctx.principals.project }] })
        alike(removed.grant.principals.map((principal) => principal.kind), [other.kind], 'principals after removing the project')
        await rejects(update({ remove: [{ kind: 'project', project: ctx.principals.project }] }), 400, 'not_in_grant', 'removing a principal the grant no longer names')
        await rejects(update({ remove: [other] }), 400, 'grant_empty', 'removing the last principal')
        await rejects(ctx.board.updateGrant(`${first.id}0`, { can: { [ci]: ['read'] } }), 404, 'grant_not_found', 'updating a grant that was never made')
      }),
  },
  {
    group: 'grants',
    name: "keeps a grant's can as written, a pattern with no permissions included",
    run: (ctx) =>
      withGrants(ctx, async ({ make }) => {
        const subtree = subtreeOf(ctx)
        const can = { [subtree]: ['read'], [`${subtree}hidden/`]: [] } as const
        const grant = await make({ principals: [projectFor(ctx, ['production', 'preview'])], can })
        alike(grant.can, can, "the grant's can")
        const listed = (await ctx.board.grants()).find((found) => found.id === grant.id)
        alike(listed?.can, can, "the listed grant's can")
        const project = listed?.principals[0]
        alike(sortedOf(project?.kind === 'project' ? project.environments : undefined), sortedOf(['preview', 'production']), "the project's environments")
      }),
  },
  {
    group: 'grants',
    name: 'lets the most specific pattern decide, then the closest principal there, and adds up ties',
    run: (ctx) =>
      withGrants(ctx, async ({ make, keep }) => {
        const subtree = subtreeOf(ctx)
        const closed = `${subtree}closed/`
        const channel = `${closed}thread`
        const project = projectFor(ctx, ['production'])
        const who = { project: ctx.principals.project, environment: 'production' }
        await keep(closed)
        await make({ principals: [project], can: { [subtree]: ['read', 'post'] } })
        const lock = await make({ principals: [{ kind: 'everyone' }], can: { [closed]: [] } })
        // A grant naming it on the subtree doesn't help where a more specific one closes it.
        const shut = await explain(ctx, channel, who)
        same(shut.pattern, closed, `the pattern that decides ${channel}`)
        check(shut.over.includes(subtree), `${closed} should win over ${subtree}, got ${show(shut.over)}`)
        same(shut.level, 'everyone', `the level that decides ${channel}`)
        check(shut.grants.some((grant) => grant.id === lock.id), `everyone's grant should decide, got ${show(shut.grants.map((grant) => grant.id))}`)
        alike(shut.can, [], `what the project may do in ${channel}`)
        const reads = await make({ principals: [project], can: { [closed]: ['read'] } })
        const posts = await make({ principals: [project], can: { [closed]: ['post'] } })
        const open = await explain(ctx, channel, who)
        same(open.level, 'principal', `the level that decides ${channel} once grants name the project there`)
        alike(sortedOf(open.grants.map((grant) => grant.id)), sortedOf([reads.id, posts.id]), 'the grants that decide, which add up')
        alike(open.can, ['read', 'post'], 'what they give together')
      }),
  },
  {
    group: 'grants',
    name: 'lets everyone narrow what something else lets in, and lets no one in itself',
    run: (ctx) =>
      withGrants(ctx, async ({ make, keep }) => {
        const subtree = subtreeOf(ctx)
        const inner = `${subtree}inner/`
        const channel = `${inner}thread`
        await keep(inner)
        await make({ principals: [{ kind: 'everyone' }], can: { [inner]: ['read'] } })
        const outsider = await explain(ctx, channel, { github: ctx.principals.repository })
        same(outsider.pattern, null, "the pattern that decides for a repository's runs nothing else lets in")
        alike(outsider.can, [], "what everyone's grant gives them")
        if (ctx.team === null) return 'this board names no team, so no project is on it for all-projects'
        const who = { project: ctx.principals.project, environment: 'production' }
        const every = { kind: 'all-projects' as const, environments: ['production'] }
        // A grant for every project names this run too, when it's one: it keeps manage here to revoke it.
        await keep(subtree)
        await make({ principals: [every], can: { [subtree]: ['read', 'post'] } })
        const narrowed = await explain(ctx, channel, who)
        same(narrowed.level, 'everyone', `the level that decides ${channel} for a project every project's grant lets in`)
        alike(narrowed.can, ['read'], 'what it may do there')
        const group = await make({ principals: [every], can: { [inner]: ['post'] } })
        const widened = await explain(ctx, channel, who)
        same(widened.level, 'group', `the level that decides ${channel} once every project's grant names it`)
        alike(widened.grants.map((grant) => grant.id), [group.id], 'the grant that decides')
        alike(widened.can, ['post'], 'what it gives, the closer level alone')
      }),
  },
  {
    group: 'grants',
    name: 'caps a person by their team role, so a viewer reads but neither posts nor manages',
    run: (ctx) => {
      const { viewer } = ctx.principals
      if (viewer === null) return Promise.resolve('name a viewer in principals to check it: a board without team roles caps no one')
      return withGrants(ctx, async ({ make }) => {
        const subtree = subtreeOf(ctx)
        await make({ principals: [viewer.includes('@') ? { kind: 'user', email: viewer } : { kind: 'user', userId: viewer }], can: { [subtree]: 'all' } })
        const explained = await explain(ctx, `${subtree}thread`, { user: viewer })
        same(explained.level, 'principal', `the level that decides ${subtree}thread for the viewer`)
        check(explained.capped !== null, `the viewer's role should cap what the grant gives, got capped ${show(explained.capped)}`)
        // What a viewer may do is the team's to say; reading, and not posting or managing, is what's checked.
        check(explained.can.includes('read') && !explained.can.includes('post') && !explained.can.includes('manage'), `what a viewer may do with a grant of all: expected read, and neither post nor manage, got ${show(explained.can)}`)
      })
    },
  },
  {
    group: 'grants',
    name: 'names an app by its slug or client ID, keeps it by client ID, and every app as a group',
    run: (ctx) => {
      const { app } = ctx.principals
      if (app === null) return Promise.resolve('name an app in principals to check it: a local board has no apps')
      return withGrants(ctx, async ({ make, keep }) => {
        const apps = `${subtreeOf(ctx)}apps/`
        // Every app there would be this run too, if it's an app: kept in, so it can revoke the grant after.
        if (ctx.me.principal.startsWith('vercel:app:')) await keep(apps)
        const grant = await make({ principals: [{ kind: 'app', app }], can: { [apps]: ['post'] } })
        const [named] = grant.principals
        check(
          grant.principals.length === 1 && named?.kind === 'app' && (named.clientId === app || named.name === app),
          `the grant's principals: expected the app ${app}, got ${show(grant.principals)}`,
        )
        const swapped = await ctx.board.updateGrant(grant.id, { add: [{ kind: 'all-apps' }], remove: [{ kind: 'app', app }] })
        alike(swapped.grant.principals, [{ kind: 'all-apps' }], 'principals after adding every app and removing the one')
      })
    },
  },
  {
    group: 'grants',
    name: 'takes manage at each pattern a grant names to change it, and at * to list them',
    run: (ctx) =>
      withGrants(ctx, async ({ make, deny, narrow }) => {
        const subtree = subtreeOf(ctx)
        const inner = `${subtree}inner/`
        const poster = narrow({ '*': ['read', 'post'] })
        // Whether this run may change grants at all, before it asks a narrowed caller to.
        const probe = await make(grantFor(ctx))
        await deny(poster, grantFor(ctx), 'a grant made without manage')
        await refused(poster.updateGrant(probe.id, { can: { [`${subtree}ci/`]: ['read'] } }), 403, 'an update without manage')
        await refused(poster.revokeGrant(probe.id), 403, 'a revoke without manage')
        await refused(poster.grants(), 403, 'listing grants without manage at *')
        await refused(poster.explain(`${subtree}thread`, { project: ctx.principals.project }), 403, "explaining a principal's access without manage at *")
        alike((await poster.explain(`${subtree}thread`)).grants, [], 'which grants decide, for a caller that may not list them')
        const manager = narrow({ '*': ['read', 'post', 'react', 'label', 'sync'], [inner]: 'all' })
        const grant = await make({ principals: [projectFor(ctx)], can: { [inner]: ['read'] } }, manager)
        await deny(manager, { principals: [projectFor(ctx)], can: { [subtree]: ['read'] } }, `a grant on ${subtree} made with manage only at ${inner}`)
        await refused(manager.updateGrant(grant.id, { can: { [subtree]: ['read'] } }), 403, `moving a grant to ${subtree} with manage only at ${inner}`)
        await refused(manager.grants(), 403, `listing grants with manage only at ${inner}`)
        same((await manager.revokeGrant(grant.id)).revoked, true, `revoking a grant on ${inner} with manage there`)
      }),
  },
  {
    group: 'grants',
    name: "lets no caller narrowed with x-board-can grant past its can, even where everyone's grant closes it",
    run: (ctx) =>
      withGrants(ctx, async ({ make, deny, narrow, keep }) => {
        const subtree = subtreeOf(ctx)
        const secret = `${subtree}secret/`
        const run = granteeOf(ctx)
        const narrowed = narrow({ '*': 'all', [secret]: [] })
        await deny(narrowed, { principals: [run], can: { [subtree]: ['read'] } }, `a grant on ${subtree} from a caller narrowed out of ${secret}`)
        // A lock there binds whoever it names as much as the caller, until it's lifted: its own limit still counts.
        await keep(secret)
        await make({ principals: [{ kind: 'everyone' }], can: { [secret]: [] } })
        await deny(narrowed, { principals: [run], can: { [subtree]: ['read'] } }, `a grant on ${subtree} from a caller narrowed out of ${secret}, once everyone is too`)
        // What it may manage, it grants.
        await make({ principals: [run], can: { [`${subtree}ci/`]: ['post'] } }, narrowed)
      }),
  },
  {
    group: 'grants',
    name: 'lets no caller narrowed with x-board-can let anyone in where everyone gets more than it has',
    run: (ctx) =>
      withGrants(ctx, async ({ make, deny, narrow, keep }) => {
        const subtree = subtreeOf(ctx)
        const open = `${subtree}open/`
        const narrowed = narrow({ '*': 'all', [open]: [] })
        await keep(open)
        await make({ principals: [{ kind: 'everyone' }], can: { [open]: ['read'] } })
        // Anyone it lets in, anywhere, would read open/ through everyone's grant.
        await deny(narrowed, { principals: [granteeOf(ctx)], can: { [`${subtree}ci/`]: ['post'] } }, `a grant from a caller narrowed out of ${open}, which everyone reads`)
      }),
  },
  {
    group: 'grants',
    name: 'lets a member grant on a pattern after a lock under it',
    // A skip, saying why: the run would be the member, shut out under the lock, and only the
    // board's owner or a grant on the run there, which would keep it in, could lift the lock after.
    run: async () => "a run can't be shut out by a lock and lift it afterwards: the board's own tests check it",
  },
  {
    group: 'grants',
    name: 'lets a project on another team in, in its environments',
    // A skip, saying why, so a report shows it's left out on purpose.
    run: async () => "grants across teams aren't specified yet: what a project on another team needs, and what all-projects means for one, comes later",
  },
  {
    group: 'schemas',
    name: 'lists the built-in schemas first, and reads a schema by its ID',
    run: async (ctx) => {
      const schemas = await ctx.board.schemas()
      const own = schemas.findIndex((schema) => !schema.builtIn)
      check(own === -1 || schemas.slice(own).every((schema) => !schema.builtIn), `schemas should list the built-ins first, got ${show(schemas.map((schema) => schema.id))}`)
      const commit = schemas.find((schema) => schema.id === 'git-commit@1')
      check(commit, `schemas should list the built-in git-commit@1, got ${show(schemas.map((schema) => schema.id))}`)
      alike({ name: commit.name, version: commit.version, builtIn: commit.builtIn, by: commit.by, at: commit.at }, { name: 'git-commit', version: 1, builtIn: true, by: null, at: null }, 'the built-in git-commit@1')
      check(commit.schema.type === 'object', `a schema's definition should describe an object, got ${show(commit.schema)}`)
      same(canonical(await ctx.board.schema('git-commit@1')), canonical(commit), 'git-commit@1, read by its ID')
      await rejects(ctx.board.schema('conformance-none@1'), 404, 'schema_not_found', 'reading a version no one registered')
      await rejects(ctx.board.schema('Not A Schema'), 400, 'invalid_schema_id', 'reading an ID that names no schema')
    },
  },
  {
    group: 'schemas',
    name: 'registers a schema version once: the same definition again changes nothing, and another is refused',
    run: async (ctx) => {
      const registered = await register(ctx)
      if ('skip' in registered) return registered.skip
      const { schema, created } = registered.made
      check(typeof created === 'boolean', `created should say whether this made it, got ${show(created)}`)
      alike(
        { id: schema.id, name: schema.name, version: schema.version, description: schema.description, builtIn: schema.builtIn },
        { id: 'conformance@1', name: SCHEMA.name, version: SCHEMA.version, description: SCHEMA.description, builtIn: false },
        'the schema it registered',
      )
      same(canonical(schema.schema), canonical(SCHEMA.schema), "the schema's definition, as it was sent")
      check(typeof schema.by === 'string' && schema.by.length > 0, `a registered schema should say who registered it, got ${show(schema.by)}`)
      check(typeof schema.at === 'string' && !Number.isNaN(Date.parse(schema.at)), `a registered schema should say when, got ${show(schema.at)}`)
      // The same definition, however its keys are ordered, is the same version.
      const again = await ctx.board.createSchema({ ...SCHEMA, schema: reversed(SCHEMA.schema) as Record<string, unknown> })
      same(again.created, false, 'whether registering the same definition again made one')
      same(canonical(again.schema), canonical(schema), 'the schema, registered again')
      await rejects(ctx.board.createSchema({ ...SCHEMA, schema: { type: 'object', required: ['run'], properties: { run: { type: 'string' } } } }), 409, 'schema_immutable', 'another definition for a version that is there')
      await rejects(ctx.board.createSchema({ ...SCHEMA, description: 'Something else.' }), 409, 'schema_immutable', 'another description for a version that is there')
      same(canonical(await ctx.board.schema(schema.id)), canonical(schema), 'the schema, read by its ID')
      const listed = (await ctx.board.schemas()).filter((found) => found.id === schema.id)
      same(listed.length, 1, `how many times schemas lists ${schema.id}`)
    },
  },
  {
    group: 'schemas',
    name: "refuses a built-in's name, and a definition it couldn't check a value against",
    run: async (ctx) => {
      // Refused before anything is kept, so a board that takes one keeps a version named for this check alone.
      const attempt = (schema: Record<string, unknown>, name = 'conformance-refused', version = 1) => ctx.board.createSchema({ name, version, schema })
      const reserved = await attempt({ type: 'object' }, 'git-commit', 2).then(
        () => null,
        (error: unknown) => error,
      )
      if (reserved instanceof BoardError && reserved.status === 403) return "this token can't register schemas"
      if (!(reserved instanceof BoardError && reserved.status === 409 && reserved.code === 'reserved_schema'))
        throw new Mismatch(`a version of the built-in git-commit: expected 409 reserved_schema, ${reserved === null ? 'and it registered one' : `got ${reserved instanceof BoardError ? `${reserved.status} ${reserved.code}` : String(reserved)}`}`)
      await rejects(attempt({ type: 'string' }), 400, 'invalid_schema', 'a schema that describes no object')
      await rejects(attempt({ type: 'object', properties: { next: { $ref: '#' } } }), 400, 'invalid_schema', 'a schema with a $ref')
      await rejects(attempt({ type: 'object', properties: { id: { type: 'string', pattern: '^(a+)+$' } } }), 400, 'invalid_schema', 'a schema with a pattern')
      await rejects(attempt({ type: 'object', properties: { ids: { type: 'array', uniqueItems: true } } }), 400, 'invalid_schema', 'a schema with uniqueItems')
    },
  },
  {
    group: 'schemas',
    name: 'carries a block in a message, checked against the schema its fence names',
    run: async (ctx) => {
      // The schema this run registers, or one an earlier run did: anyone who posts may use it.
      const registered = await register(ctx)
      if ('skip' in registered && !(await ctx.board.schema('conformance@1').then(() => true, () => false))) return `${registered.skip}, and none registered conformance@1 before it`
      const data = { run: ctx.labels.conformance, outcome: 'passed', checks: [{ name: 'a block', skipped: false }] }
      const text = `conformance: a block among prose\n\n${block('conformance@1', data)}\n\nand after it`
      const message = await post(ctx, text)
      same(message.text, text, "the post's text, as it was written")
      same(canonical(message.blocks), canonical([{ schema: 'conformance', version: 1, data }]), "the post's blocks")
      same(canonical((await ctx.board.thread(message.id)).message.blocks), canonical(message.blocks), "the post's blocks, read back")
      // A message that is only its block, and one that only shows one, in a longer fence.
      const alone = await post(ctx, block('conformance@1', data))
      same(canonical(alone.blocks), canonical([{ schema: 'conformance', version: 1, data }]), 'the blocks of a message that is only one')
      const shown = await post(ctx, `conformance: a block shown, not carried\n\n\`\`\`\`\n${block('conformance@1', { outcome: 'maybe' })}\n\`\`\`\``)
      same(canonical(shown.blocks), '[]', 'the blocks of a message that shows one inside a longer fence')
      same(canonical((await post(ctx, 'conformance: no block')).blocks), '[]', 'the blocks of a message with none')
      // One that doesn't match, or names a schema no one registered, isn't written.
      const refusedPost = (body: string) =>
        ctx.board.post(ctx.channel, { text: body, labels: ctx.labels, noSync: true }).then((wrong) => {
          ctx.posted.push(wrong.id)
          return wrong
        })
      await rejects(refusedPost(block('conformance@1', { run: ctx.labels.conformance, outcome: 'maybe' })), 400, 'invalid_block', "a post whose block doesn't match its schema")
      await rejects(refusedPost(block('conformance-none@1', { run: ctx.labels.conformance })), 400, 'schema_not_found', 'a post whose block names a schema no one registered')
      await rejects(ctx.board.edit(alone.id, block('conformance@1', { outcome: 'passed' })), 400, 'invalid_block', "an edit whose block doesn't match its schema")
      same(canonical((await ctx.board.thread(alone.id)).message.blocks), canonical(alone.blocks), 'the blocks of a message after an edit that was refused')
    },
  },
  {
    group: 'schemas',
    name: 'refuses a caller narrowed with x-board-can a schema, and lets it read them',
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const narrowed = ctx.withCan(`${ctx.channel}=read,post`)
      check((await narrowed.schemas()).some((schema) => schema.id === 'git-commit@1'), 'a caller narrowed to a channel should read the schemas')
      // The one this run registers, so a board that takes it keeps nothing new.
      await narrowedOut(narrowed.createSchema(SCHEMA), 'registering a schema')
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
      // Nothing's woken while it checks, and an empty one gets back where it's woken after.
      const where = wokenAt(registered)
      await ctx.board.register({ watch: { conformance: { tail: `${ctx.channel} --label conformance=${ctx.labels.conformance}` } } })
      try {
        const message = await post(ctx, 'conformance: for a watcher')
        const deadline = Date.now() + 10_000
        let match: Awaited<ReturnType<Board['matches']>>[number] | undefined
        while (!match && Date.now() < deadline) match = (await ctx.board.matches({ wait: 5 })).find((m) => m.event.message?.id === message.id)
        check(match, 'a pull should hand out the match for the post')
        same(match.watcher, 'conformance', "the match's watcher")
        await ctx.board.ack(match.id, { lease: match.lease })
        await rejects(ctx.board.ack(match.id, { lease: match.lease }), 404, 'no_match', 'acking a match twice')
      } finally {
        await ctx.board.register({ ...where, watch: {} })
      }
    },
  },
  {
    group: 'watchers',
    name: 'wakes by path only where its discovery says so, and only a Vercel project',
    run: async (ctx) => {
      // Even a refusal can replace them: a board that doesn't know `path` reads one as a registration with nothing in it.
      const registered = (await ctx.board.watchers()).find((r) => r.owner === ctx.me.principal)
      if (registered && (Object.keys(registered.watch).length > 0 || (registered.sync?.length ?? 0) > 0))
        return 'this token has watchers or a sync registered here, and checking would replace them'
      const byPath = (await ctx.board.discovery()).wake_by_path
      // A path wakes a project's deployment in any environment, a preview's by its branch when it names one.
      const environment = /^vercel:project:[^:]+:(.+)$/.exec(ctx.me.principal)?.[1] ?? null
      const where = wokenAt(registered)
      const branch = environment === 'preview' ? { branch: 'conformance' } : {}
      const attempt = () => ctx.board.register({ path: '/conformance', ...branch, watch: {} })
      try {
        if (!byPath) await rejects(attempt(), 501, 'no_wake_by_path', 'a path, on a board that wakes nothing')
        else if (environment === null) await rejects(attempt(), 403, 'not_a_project', "a path, from a token that isn't a Vercel project's")
        else {
          const view = await attempt()
          same(view.path, '/conformance', "the registration's path")
          same(view.url, null, "the registration's url")
          same(view.branch ?? null, environment === 'preview' ? 'conformance' : null, "the registration's branch")
        }
      } finally {
        await ctx.board.register({ ...where, watch: {} })
      }
    },
  },
  {
    group: 'watchers',
    name: "refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking",
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const narrowed = ctx.withCan(`${ctx.channel}=all`)
      const registered = (await ctx.board.watchers()).find((r) => r.owner === ctx.me.principal)
      // What's registered now, so a board that wrongly takes it leaves the registration as it was.
      const now = { ...wokenAt(registered), watch: registered?.watch ?? {}, ...(registered?.sync ? { sync: registered.sync } : {}) }
      await narrowedOut(narrowed.register(now), 'registering watchers')
      await narrowedOut(narrowed.matches(), 'pulling matches')
      await narrowedOut(narrowed.ack(`conformance-${ctx.labels.conformance}`, { lease: 'conformance' }), 'acking a match')
    },
  },
  {
    group: 'sync',
    name: "keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced",
    run: async (ctx) => {
      const key = SYNC_KEY
      const thread = `${key}:${ctx.labels.conformance}:1`
      const author = { id: `${key}:user:${ctx.labels.conformance}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      const origin = { thread, message: '1' }
      // A sync names its entries when it registers.
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      const { where } = registered
      let imported: { message: string | null }
      try {
        imported = await ctx.board.syncImport({
          op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform', labels: ctx.labels, noSync: true,
          origin: { channel: `${key}:${ctx.labels.conformance}`, thread, subthread: null, message: '1', context: null },
          id: `conformance-sync-${ctx.labels.conformance}`,
        })
      } catch (error) {
        await ctx.board.register({ ...where, watch: {} }).catch(() => {})
        if (error instanceof BoardError && error.status === 403) return `this token can't sync in ${ctx.channel}`
        throw error
      }
      const id = imported.message
      isRef(id, "an import's message")
      try {
        const message = (await ctx.board.thread(id!)).message
        // A sync elsewhere's word: the platform user as a profile of its principal, shown through it.
        same(message.by.actor, `${ctx.me.principal}+${author.id}`, "the import's author")
        same(message.by.principal, ctx.me.principal, "the import's principal")
        same(message.by.profile, author.id, "the import's profile")
        same(message.author?.name, author.name, "the import's author's name")
        check(message.author?.via !== undefined, `the import's author should say who it's via, got ${show(message.author)}`)
        same(message.from, key, "the import's from")
        same(message.origin?.thread, thread, "the import's origin")
        const found = await ctx.board.syncFind({ thread, message: '1' })
        same(found.message, id, 'the message found by its platform IDs')
        check(found.thread !== null, 'the thread found by its platform thread')
        same((await ctx.board.syncThread(found.thread!)).root, id, "the synced thread's root")
        const again = await ctx.board.syncImport({ op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: from a platform', noSync: true, id: `conformance-sync-${ctx.labels.conformance}` })
        same(again.message, id, 'the same import, sent again')
        // A platform thread is one board thread's: another import can't take it over.
        await rejects(
          ctx.board.syncImport({ op: 'post', author, from: key, channel: ctx.channel, text: 'conformance: a second root', noSync: true, origin: { thread, subthread: null, message: '3', context: null } }),
          409,
          'already_synced',
          'an import from a platform thread another board thread syncs with',
        )
        // A delivery is to one of its thread's targets.
        const external = { thread: `${key}:${ctx.labels.conformance}:2`, message: '2' }
        await ctx.board.syncReceipt({ kind: 'thread', message: id!, target: external.thread, targetKind: 'thread', cause: 'request' })
        await ctx.board.syncReceipt({ kind: 'message', message: id!, target: external.thread, external })
        same(JSON.stringify((await ctx.board.syncCopies([id!]))[id!]?.[external.thread]), JSON.stringify(external), 'the copy its receipt recorded')
        // Readers see where it's synced from the same records, and a link no sync here knows names nothing.
        const { targets } = await ctx.board.sync(id!)
        check(targets.some((row) => row.target === external.thread && row.message === external.message), `where the thread is synced should show the copy its receipt recorded, got ${show(targets)}`)
        await rejects(ctx.board.linked(`https://conformance.invalid/${ctx.labels.conformance}`), 404, 'message_not_found', 'a link no sync here knows')
      } finally {
        // Its author is the platform user: only an import can take it down.
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin }).catch(() => {})
        // And a second root, on a board that took one.
        await ctx.board.syncImport({ op: 'delete', author, from: key, origin: { thread, message: '3' } }).catch(() => {})
        await ctx.board.register({ ...where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: "queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked",
    run: async (ctx) => {
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      try {
        const run = ctx.labels.conformance
        const author = { id: `${SYNC_KEY}:user:${run}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
        const thread = `${SYNC_KEY}:${run}:inbox`
        const eventOf = (message: string) => ({
          id: `conformance-inbox-${run}-${message}`,
          event: { kind: 'message' as const, channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message, isRoot: message === '1', text: `conformance: inbox event ${message}`, context: null, author },
          raw: { conformance: run, message },
        })
        const pushed = [eventOf('1'), eventOf('2')]
        await ctx.board.inboxPush(SYNC_KEY, pushed)
        // A platform's retry of an event lands once.
        await ctx.board.inboxPush(SYNC_KEY, [pushed[0]!])
        const lease = async () => (await ctx.board.inboxNext(SYNC_KEY, { limit: 50 })).filter((item) => item.thread === thread)
        // A platform thread's events come one at a time, in order: each only once the one before is acked.
        for (const { event, raw } of pushed) {
          const leased = await lease()
          same(leased.length, 1, `the events leased from the platform thread, for message ${event.message}`)
          const item = leased[0]!
          same(item.event.kind === 'message' ? item.event.message : null, event.message, 'the platform message leased next')
          same(JSON.stringify(item.raw), JSON.stringify(raw), "the leased event's raw payload")
          await ctx.board.inboxAck(SYNC_KEY, item.id, { lease: item.lease })
        }
        same((await lease()).length, 0, 'the events leased once both are acked')
      } finally {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: "takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one",
    run: async (ctx) => {
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      try {
        const run = ctx.labels.conformance
        const author = { id: `${SYNC_KEY}:user:${run}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
        const thread = `${SYNC_KEY}:${run}:long`
        const location = { channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message: '1', author }
        // A deployment comment, edited from Building to Ready: thousands of characters, as platforms send them.
        const text = (status: string) => `conformance: ${status}\n${'| project | deployment | preview | updated |\n'.repeat(250)}`
        const idOf = (kind: string) => `conformance-inbox-${run}-long-${kind}-`.padEnd(INBOX_EVENT_ID_MAX, 'x')
        const pushed = [
          { id: idOf('message'), event: { kind: 'message' as const, ...location, isRoot: true, text: text('Building'), context: null }, raw: null },
          { id: idOf('edited'), event: { kind: 'edited' as const, ...location, text: text('Ready') }, raw: null },
        ]
        for (const event of pushed) await ctx.board.inboxPush(SYNC_KEY, [event])
        await refused(
          ctx.board.inboxPush(SYNC_KEY, [{ ...pushed[1]!, id: `${pushed[1]!.id}x` }]),
          400,
          `an inbox event ID over ${INBOX_EVENT_ID_MAX} characters`,
        )
        for (const { event } of pushed) {
          const leased = (await ctx.board.inboxNext(SYNC_KEY, { limit: 50 })).filter((item) => item.thread === thread)
          same(leased.length, 1, `the events leased from the platform thread, for its ${event.kind} event`)
          const item = leased[0]!
          same(item.event.kind, event.kind, 'the platform event leased next')
          same('text' in item.event ? item.event.text : null, event.text, `the ${event.kind} event's text`)
          await ctx.board.inboxAck(SYNC_KEY, item.id, { lease: item.lease })
        }
      } finally {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: 'hands a sync each message change as a match of its @sync watcher',
    run: async (ctx) => {
      // A token that syncs elsewhere but not here gets no match for a post here. One that names no
      // sync anywhere, as a board that lists no permissions, is checked.
      const access = compileAccess(ctx.me.can)
      if (access.anywhere('sync') && !access.can('sync', ctx.channel)) return `this token can't sync in ${ctx.channel}`
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      try {
        const message = await post(ctx, 'conformance: for a sync')
        const deadline = Date.now() + 10_000
        let match: Awaited<ReturnType<Board['matches']>>[number] | undefined
        while (!match && Date.now() < deadline) match = (await ctx.board.matches({ wait: 5 })).find((m) => m.watcher === '@sync' && m.event.message?.id === message.id)
        check(match, "a pull should hand the sync a match for the post, as its @sync watcher's")
        same(match.event.type, 'message.posted', "the sync's match")
        await ctx.board.ack(match.id, { lease: match.lease })
      } finally {
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
  {
    group: 'sync',
    name: 'keeps noSync on a post and a reply, so sync sends neither',
    run: async (ctx) => {
      const { root, reply } = needRoot(ctx)
      const thread = await ctx.board.thread(root.id)
      same(thread.message.noSync, true, "a post's noSync, read back")
      same(thread.replies.find((m) => m.id === reply.id)?.noSync, true, "a reply's noSync, read back")
    },
  },
  {
    group: 'sync',
    name: "refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox",
    run: async (ctx) => {
      if (!ctx.withCan) return NO_CAN
      const { root } = needRoot(ctx)
      const registered = await registerSync(ctx)
      if ('skip' in registered) return registered.skip
      const run = ctx.labels.conformance
      const author = { id: `${SYNC_KEY}:user:${run}`, handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }
      const thread = `${SYNC_KEY}:${run}:narrowed`
      try {
        const narrowed = ctx.withCan(`${ctx.channel}=all`)
        await narrowedOut(
          narrowed.syncImport({
            op: 'post', author, from: SYNC_KEY, channel: ctx.channel, text: 'conformance: a narrowed import', labels: ctx.labels, noSync: true,
            origin: { channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message: '1', context: null },
          }),
          'an import',
        )
        await narrowedOut(narrowed.syncReceipt({ kind: 'failed', message: root.id, target: thread, error: 'conformance' }), 'a receipt')
        const event = { kind: 'message' as const, channel: `${SYNC_KEY}:${run}`, thread, subthread: null, message: '1', isRoot: true, text: 'conformance: a narrowed push', context: null, author }
        await narrowedOut(narrowed.inboxPush(SYNC_KEY, [{ id: `conformance-narrowed-${run}`, event, raw: null }]), 'a push to the inbox')
        await narrowedOut(narrowed.inboxNext(SYNC_KEY, { limit: 1 }), 'a lease from the inbox')
        await narrowedOut(narrowed.inboxAck(SYNC_KEY, `conformance-narrowed-${run}`, { lease: 'conformance' }), 'an ack to the inbox')
      } finally {
        // An import a board wrongly took: only an import can take it down.
        await ctx.board.syncImport({ op: 'delete', author, from: SYNC_KEY, origin: { thread, message: '1' } }).catch(() => {})
        await ctx.board.register({ ...registered.where, watch: {} }).catch(() => {})
      }
    },
  },
]

/**
 * Why `principals` can't be the ones the grants checks name: one that is this run's own (its
 * project, or its repository from a GitHub run) would have the checks change what the run itself
 * may do, part way through. Null when they're another's.
 */
function namesCaller(me: Me, principals: ConformanceOptions['principals']): string | null {
  const [source, kind, id] = me.principal.split(':')
  const project = principals?.project
  if (project !== undefined && source === 'vercel' && kind === 'project' && (project === id || project === me.handle))
    return `principals.project is this run's own project, ${project}: the grants checks would change what this run may do. Name another project on the team.`
  const repository = principals?.repository?.toLowerCase()
  if (repository !== undefined && me.kind === 'workflow' && repository === me.handle.toLowerCase())
    return `principals.repository is this run's own repository, ${principals!.repository}: the grants checks would change what this run may do. Name another repository.`
  const app = principals?.app
  if (app !== undefined && source === 'vercel' && kind === 'app' && (app === id || app === me.handle))
    return `principals.app is this run's own app, ${app}: the grants checks would change what this run may do. Name another app on the team.`
  return null
}

/**
 * Why `project`, a name the board looks up, can't be the one the grants checks name: it's this run's
 * own. A name can't be told apart before the board resolves it, so this makes one grant that
 * changes nothing for the run (the project's deployments in another environment, posting in the
 * subtree's `ci/`), reads the project it resolved to, and revokes it. Null when it's another's, or
 * when the board made no such grant, which the grants checks then say why.
 */
async function ownProjectByName(board: Board, me: Me, channel: string, project: string | undefined): Promise<string | null> {
  const [source, kind, id, environment] = me.principal.split(':')
  if (project === undefined || source !== 'vercel' || kind !== 'project' || project === id) return null
  let grant: GrantView
  try {
    ;({ grant } = await board.createGrant({ principals: [{ kind: 'project', project, environments: [environment === 'preview' ? 'development' : 'preview'] }], can: { [`${channel}/grants/ci/`]: ['post'] } }))
  } catch {
    return null
  }
  // A revoke that fails throws: the run mustn't go on with it, or leave it unsaid.
  await board.revokeGrant(grant.id)
  const [named] = grant.principals
  return named?.kind === 'project' && named.projectId === id
    ? `principals.project is this run's own project, ${project} (${id}): the grants checks would change what this run may do. Name another project on the team.`
    : null
}

/**
 * Runs the checks against `board`, in order, and reports each. It never throws for what the board
 * answers; it throws before it writes anything when `principals` names the run itself.
 */
export async function conformance(board: Board, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const checks: CheckResult[] = []
  const discovery = await board.discovery().catch((error: unknown) => error as Error)
  const wrong =
    discovery instanceof Error
      ? discovery.message
      : typeof discovery.audience !== 'string' || typeof discovery.url !== 'string' || !Array.isArray(discovery.sync)
        ? `discovery should have url, audience, and sync, got ${show(discovery)}`
        : null
  if (wrong !== null) {
    checks.push({ group: 'core', name: 'says in its discovery where it is', status: 'failed', detail: wrong })
    return { url: board.url, checks, ok: false }
  }
  // The board it checks, as it names itself: a handle on one elsewhere has no URL of its own.
  const url = (discovery as { url: string }).url
  checks.push({ group: 'core', name: 'says in its discovery where it is', status: 'passed' })
  const me = await board.me()
  const own = namesCaller(me, options.principals)
  if (own !== null) throw new TypeError(own)
  const channel = options.channel ?? 'conformance'
  const ownByName = await ownProjectByName(board, me, channel, options.principals?.project)
  if (ownByName !== null) throw new TypeError(ownByName)
  const label = crypto.randomUUID().slice(0, 8)
  const ctx: Context = {
    board,
    channel,
    labels: { conformance: label },
    start: (await board.messages({ channel, limit: 1 })).cursor,
    me,
    posted: [],
    ...(options.withCan ? { withCan: options.withCan } : options.withHeaders ? { withCan: (can: string) => options.withHeaders!({ 'x-board-can': can }) } : {}),
    ...(options.withHeaders ? { withHeaders: options.withHeaders } : {}),
    principals: {
      project: options.principals?.project ?? `prj_conformance${label}`,
      repository: options.principals?.repository ?? `acme/conformance-${label}`,
      viewer: options.principals?.viewer ?? null,
      app: options.principals?.app ?? null,
    },
    team: (discovery as { team_id?: string | null }).team_id ?? null,
  }
  try {
    for (const { group, name, run } of CHECKS) {
      try {
        const skipped = await run(ctx)
        checks.push(skipped ? { group, name, status: 'skipped', detail: skipped } : { group, name, status: 'passed' })
      } catch (error) {
        if (OPTIONAL.has(group) && error instanceof BoardError && error.status === 501) checks.push({ group, name, status: 'skipped', detail: `not kept here: ${error.message}` })
        // Vercel's API takes watchers only from a deployment: a run as anyone else can't check them.
        else if (group === 'watchers' && error instanceof BoardError && error.code === 'watchers_need_project') checks.push({ group, name, status: 'skipped', detail: 'only a deployment registers watchers here' })
        // Vercel's API takes no GitHub or OIDC principal in a grant.
        else if (group === 'grants' && error instanceof BoardError && error.code === 'unsupported_principal') checks.push({ group, name, status: 'skipped', detail: 'this board takes no GitHub or OIDC principals in a grant' })
        else checks.push({ group, name, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    // What it posted goes, replies first. A failure here leaves a tombstone short, not a wrong report.
    for (const id of [...ctx.posted].reverse()) await board.delete(id).catch(() => {})
  }
  return { url, checks, ok: checks.every((c) => c.status !== 'failed') }
}
