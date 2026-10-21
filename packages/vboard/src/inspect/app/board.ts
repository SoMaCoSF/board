import { useSyncExternalStore } from 'react'
import type { BoardEventView, InboxEntry } from '../../api/routes.ts'
import type { Attachment } from '../../contract/schemas.ts'
import { http } from '../../backend-http/index.default.ts'
import { board } from '../../server/index.default.ts'
import * as store from './store.ts'

// The page's connection to the board: a handle like any other, on the inspector's
// proxy, which adds your credentials. Its fetch sends the page's own: the per-run
// token, and the profile you picked.

const token = document.querySelector<HTMLMetaElement>('meta[name="inspect-token"]')?.content ?? ''

let state = store.initialState
const listeners = new Set<() => void>()

function set(next: (state: store.State) => store.State) {
  const updated = next(state)
  if (updated === state) return
  state = updated
  for (const listener of listeners) listener()
}

export function useBoard(): store.State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export const getState = () => state

// --- who you post as: the CLI's identity, or a profile picked here ----------------------

const PROFILE_KEY = 'vboard.profile'

/** `undefined`: as `vb inspect` started. `null`: yourself. A string: that profile. */
let profile: string | null | undefined = (() => {
  try {
    const stored = localStorage.getItem(PROFILE_KEY)
    return stored === null ? undefined : (JSON.parse(stored) as string | null)
  } catch {
    return undefined
  }
})()

export const getProfile = () => profile

const client = board({
  backend: http(`${location.origin}/board`, {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-inspect-token', token)
      if (profile !== undefined) headers.set('x-inspect-profile', profile ?? '')
      // The feed is a long-poll: it's live while one is out, and each answers when there's news.
      const live = String(input).includes('/board/events')
      if (live) set((s) => (s.live === 'reconnecting' ? s : { ...s, live: 'live' }))
      try {
        const response = await fetch(input, { ...init, headers })
        if (live) set((s) => ({ ...s, live: response.ok ? 'live' : 'reconnecting' }))
        return response
      } catch (error) {
        if (live && !init?.signal?.aborted) set((s) => ({ ...s, live: 'reconnecting' }))
        throw error
      }
    },
  }),
})

/** Switches who you post as, then learns the identity that is. */
export async function setProfile(next: string | null | undefined) {
  const previous = profile
  profile = next
  try {
    if (next === undefined) localStorage.removeItem(PROFILE_KEY)
    else localStorage.setItem(PROFILE_KEY, JSON.stringify(next))
  } catch {}
  try {
    const me = await client.me()
    set((s) => ({ ...s, me }))
  } catch (error) {
    profile = previous
    toast(`couldn't switch: ${message(error)}`)
  }
}

// --- which message you're editing ---------------------------------------------------

let editing: string | null = null
const editingListeners = new Set<() => void>()

export function setEditing(id: string | null) {
  editing = id
  editingListeners.forEach((listener) => listener())
}

export function useEditing(): string | null {
  return useSyncExternalStore(
    (listener) => {
      editingListeners.add(listener)
      return () => editingListeners.delete(listener)
    },
    () => editing,
  )
}

// --- errors ------------------------------------------------------------------

export type Toast = { id: number; text: string }
let toasts: Toast[] = []
const toastListeners = new Set<() => void>()
let toastId = 0

export function toast(text: string) {
  const id = ++toastId
  toasts = [...toasts, { id, text }]
  toastListeners.forEach((listener) => listener())
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    toastListeners.forEach((listener) => listener())
  }, 6000)
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener)
      return () => toastListeners.delete(listener)
    },
    () => toasts,
  )
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// --- loading -------------------------------------------------------------------

const loaded = new Map<string, Promise<void>>()

/** Loads once per key; a failure can be retried. */
function once(key: string, load: () => Promise<void>): Promise<void> {
  let promise = loaded.get(key)
  if (!promise) {
    promise = load().catch((error) => {
      loaded.delete(key)
      toast(message(error))
    })
    loaded.set(key, promise)
  }
  return promise
}

export async function boot() {
  const [me, discovery, channels, recent] = await Promise.all([
    client.me(),
    client.discovery().catch(() => null),
    client.channels(),
    client.messages({ limit: 200 }),
  ])
  set((s) =>
    store.merge(
      { ...s, me, discovery, channels: Object.fromEntries(channels.map((c) => [c.path, c])), cursor: recent.cursor },
      recent.messages,
    ),
  )
  void stream(recent.cursor)
}

/** Folds the live stream in, a frame's worth of events at a time. */
async function stream(after: string) {
  let queue: BoardEventView[] = []
  let scheduled = false
  const flush = () => {
    scheduled = false
    const events = queue
    queue = []
    set((s) => events.reduce(store.applyEvent, s))
  }
  try {
    for await (const event of client.events({ all: true, after })) {
      queue.push(event)
      if (!scheduled) {
        scheduled = true
        requestAnimationFrame(flush)
      }
    }
  } catch (error) {
    // The SDK retries dropped connections itself; this is the board refusing the stream.
    set((s) => ({ ...s, live: 'reconnecting' }))
    toast(`live updates stopped: ${message(error)}`)
  }
}

const PAGE = 200

/** Whether older messages exist past what's loaded, per channel. */
const exhausted = new Set<string>()

export const loadChannel = (channel: string) =>
  once(`channel:${channel}`, async () => {
    const page = await client.messages({ channel, limit: PAGE })
    if (page.messages.length < PAGE) exhausted.add(channel)
    set((s) => store.merge(s, page.messages))
  })

export async function loadOlder(channel: string): Promise<boolean> {
  const oldest = Object.values(state.messages)
    .filter((m) => m.channel === channel)
    .sort(store.byWritten)[0]
  if (exhausted.has(channel) || !oldest) return false
  try {
    const page = await client.messages({ channel, before: oldest.id, limit: PAGE })
    if (page.messages.length < PAGE) exhausted.add(channel)
    set((s) => store.merge(s, page.messages))
    return !exhausted.has(channel)
  } catch (error) {
    toast(message(error))
    return true
  }
}

export const hasOlder = (channel: string) => !exhausted.has(channel)

export const loadThread = (id: string) =>
  once(`thread:${id}`, async () => {
    const { message: root, replies } = await client.thread(id)
    set((s) => store.merge(s, [root, ...replies]))
  })

export const loadInbox = (key: string): Promise<InboxEntry[]> => client.inbox(key, { limit: 100 })

/**
 * History that matches a view's filters, from the board, so a filter finds
 * older messages too; the live stream keeps it current. Replies come with their
 * thread's root, which the page needs to show them and to match its labels.
 */
export const loadFiltered = (channel: string | undefined, filter: store.Filter) =>
  once(`filtered:${channel ?? '*'}:${JSON.stringify(filter)}`, async () => {
    const page = await client.messages({
      ...(channel ? { channel } : {}),
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.text ? { text: filter.text } : {}),
      ...(filter.label.length > 0 ? { label: filter.label } : {}),
      limit: PAGE,
    })
    set((s) => store.merge(s, page.messages))
    const missing = [...new Set(page.messages.flatMap((m) => (m.re !== null && !state.messages[m.re] ? [m.re] : [])))].slice(0, 30)
    await Promise.all(missing.map((id) => loadThread(id)))
  })

// --- writes --------------------------------------------------------------------

/** A post's files, kept until it lands so a retry can send them again. */
const outgoing = new Map<string, File[]>()

/** Shows a post at once; the board's answer replaces it. Files upload first. */
export async function send(
  post: { channel: string; re: string | null; text: string; noSync: boolean; labels: Record<string, string>; files?: File[] },
  key: string = crypto.randomUUID(),
) {
  const files = post.files ?? outgoing.get(key) ?? []
  outgoing.set(key, files)
  const pending: store.Pending = {
    channel: post.channel,
    re: post.re,
    text: post.text,
    noSync: post.noSync,
    labels: post.labels,
    ...(files.length ? { files: files.map((f) => ({ name: f.name, size: f.size })) } : {}),
    key,
    createdAt: new Date().toISOString(),
    error: null,
  }
  set((s) => ({ ...s, pending: [...s.pending.filter((p) => p.key !== key), pending] }))
  try {
    const attachments = await Promise.all(files.map((file) => client.upload({ data: file, name: file.name })))
    const options = {
      text: post.text,
      id: key,
      ...(attachments.length ? { attachments } : {}),
      ...(post.noSync ? { noSync: true } : {}),
      ...(Object.keys(post.labels).length > 0 ? { labels: post.labels } : {}),
    }
    const sent = post.re === null ? await client.post(post.channel, options) : await client.reply(post.re, options)
    outgoing.delete(key)
    set((s) => store.merge({ ...s, pending: s.pending.filter((p) => p.key !== key) }, [sent]))
  } catch (error) {
    set((s) => ({ ...s, pending: s.pending.map((p) => (p.key === key ? { ...p, error: message(error) } : p)) }))
  }
}

export const retry = ({ files: _shown, ...pending }: store.Pending) => send(pending, pending.key)

// --- attachments -----------------------------------------------------------------

const objectUrls = new Map<string, Promise<string>>()

/** An attachment as a `blob:` URL. The page fetches it with its token: an `<img>` can't send one. */
export function attachmentUrl(id: string): Promise<string> {
  let url = objectUrls.get(id)
  if (!url) {
    url = client.download(id).then(async (response) => URL.createObjectURL(await response.blob()))
    url.catch(() => objectUrls.delete(id))
    objectUrls.set(id, url)
  }
  return url
}

/** Saves an attachment under its own name. */
export async function saveAttachment(attachment: Attachment) {
  try {
    const link = document.createElement('a')
    link.href = await attachmentUrl(attachment.id)
    link.download = attachment.name
    link.click()
  } catch (error) {
    toast(`couldn't download ${attachment.name}: ${message(error)}`)
  }
}
export const discard = (key: string) => {
  outgoing.delete(key)
  set((s) => ({ ...s, pending: s.pending.filter((p) => p.key !== key) }))
}

/**
 * Applies a change at once and sends it. The board's next view of the message
 * confirms it; if that never comes, the overlay drops after a while and the
 * board's view stands.
 */
async function change(id: string, op: store.Op, run: () => Promise<unknown>) {
  const opId = crypto.randomUUID()
  set((s) => store.addOp(s, id, opId, op))
  try {
    await run()
    setTimeout(() => set((s) => store.dropOp(s, id, opId)), 8000)
  } catch (error) {
    set((s) => store.dropOp(s, id, opId))
    toast(message(error))
  }
}

export const react = (id: string, emoji: string, remove: boolean) =>
  change(id, { kind: 'react', emoji, remove }, () => client.react(id, emoji, { remove }))

export const edit = (id: string, text: string) => change(id, { kind: 'edit', text }, () => client.edit(id, text))

export const remove = (id: string) => change(id, { kind: 'delete' }, () => client.delete(id))

export const label = (id: string, put: Record<string, string>, unset: string[]) =>
  change(id, { kind: 'label', set: put, unset }, () => client.label(id, { set: put, unset }))
