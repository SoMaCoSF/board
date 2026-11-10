import { describe, expect, it } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import * as store from '../src/inspect/app/store.ts'
import { continues } from '../src/inspect/app/store.ts'

const ME = 'vercel:user:u_julian'

function message(id: number, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: String(id),
    version: id,
    revision: id,
    channel: 'ops',
    text: `message ${id}`,
    re: null,
    replyTo: null,
    thread: `t${id}`,
    labels: {},
    reactions: {},
    by: { actor: ME, principal: 'vercel:user:u_julian', profile: null, session: null },
    noSync: false,
    origin: null,
    from: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    editedAt: null,
    deleted: false,
    undelivered: {},
    attachments: [],
    links: [],
    author: { kind: 'person', handle: 'julian', name: 'julian', avatar: null },
    ...overrides,
  }
}

/** A message.posted event as the stream sends it: its payload mirrors the message. */
const postedEvent = (m: MessageView): BoardEventView => ({
  cursor: String(m.version),
  type: 'message.posted',
  createdAt: '',
  payload: {
    channel: m.channel,
    text: m.text,
    re: m.re,
    replyTo: m.replyTo,
    thread: m.thread,
    labels: m.labels,
    noSync: m.noSync,
    by: m.by,
    origin: m.origin,
    from: m.from,
  },
  message: m,
})

const start: store.State = { ...store.initialState, me: { actor: ME } as store.State['me'] }

describe('the inspector store', () => {
  it('keeps the newest view of a message, whatever order views arrive in', () => {
    let state = store.merge(start, [message(1, { text: 'new', version: 10 })])
    state = store.merge(state, [message(1, { text: 'old', version: 5 })])
    expect(state.messages['1']!.text).toBe('new')
    state = store.merge(state, [message(1, { text: 'newer', version: 11 })])
    expect(state.messages['1']!.text).toBe('newer')
  })

  it('folds live events in, and counts new threads', () => {
    const posted = postedEvent(message(3, { channel: 'new' }))
    let state = store.applyEvent(start, posted)
    expect(state.channels.new).toMatchObject({ threads: 1, messages: 1, lastIndex: 3 })
    expect(state.cursor).toBe('3')
    state = store.applyEvent(state, posted) // a repeat counts once
    expect(state.channels.new!.messages).toBe(1)
    state = store.applyEvent(state, {
      cursor: '4',
      type: 'actor.seen',
      createdAt: '',
      payload: { actor: ME, kind: 'person', handle: 'julian', name: 'Julian', avatar: 'https://example.com/a.png' },
    })
    expect(store.shown(state, '3')!.author).toMatchObject({ name: 'Julian', avatar: 'https://example.com/a.png' })
  })

  it("makes up no counts on a board that keeps none, as a team board in Vercel's API doesn't", () => {
    let state: store.State = { ...start, channels: { general: { path: 'general' } } }
    state = store.applyEvent(state, postedEvent(message(1, { channel: 'general' })))
    state = store.applyEvent(state, postedEvent(message(2, { channel: 'dev/web' })))
    expect(state.channels).toEqual({ general: { path: 'general' }, 'dev/web': { path: 'dev/web' } })
  })

  it('lists a channel created while it is open, and keeps the counts of one a post made first', () => {
    const created = (channel: string, cursor: string): BoardEventView => ({
      cursor,
      type: 'channel.created',
      createdAt: '',
      payload: { channel, by: { actor: ME, principal: ME, profile: null, session: null } },
    })
    let state = store.applyEvent(start, created('dev/alerts', '2'))
    expect(state.channels['dev/alerts']).toEqual({ path: 'dev/alerts', lastIndex: 0, messages: 0, threads: 0 })
    state = store.applyEvent(state, postedEvent(message(3, { channel: 'ops' })))
    state = store.applyEvent(state, created('ops', '4'))
    expect(state.channels.ops).toMatchObject({ messages: 1, threads: 1, lastIndex: 3 })
  })

  it('shows your changes at once, until the board confirms them', () => {
    let state = store.merge(start, [message(1)])
    state = store.addOp(state, '1', 'a', { kind: 'react', emoji: '+1', remove: false })
    state = store.addOp(state, '1', 'b', { kind: 'label', set: { status: 'open' }, unset: [] })
    expect(store.shown(state, '1')).toMatchObject({ reactions: { thumbs_up: [ME] }, labels: { status: 'open' } })

    // The board confirms the reaction; the label is still on its way.
    state = store.merge(state, [message(1, { reactions: { thumbs_up: [ME] }, version: 2 })])
    expect(state.ops['1']!.map((entry) => entry.id)).toEqual(['b'])
    expect(store.shown(state, '1')).toMatchObject({ reactions: { thumbs_up: [ME] }, labels: { status: 'open' } })

    state = store.dropOp(state, '1', 'b') // the write failed
    expect(store.shown(state, '1')!.labels).toEqual({})
  })

  it('removes a reaction you take back, and tombstones a delete', () => {
    let state = store.merge(start, [message(1, { reactions: { eyes: [ME, 'slack:user:U1'] } })])
    state = store.addOp(state, '1', 'a', { kind: 'react', emoji: 'eyes', remove: true })
    expect(store.shown(state, '1')!.reactions).toEqual({ eyes: ['slack:user:U1'] })
    state = store.addOp(state, '1', 'b', { kind: 'delete' })
    expect(store.shown(state, '1')).toMatchObject({ deleted: true, text: '', reactions: {} })
  })

  it('never shows a post twice when the stream beats the board\'s answer', () => {
    const post: store.Pending = { key: 'k', channel: 'ops', re: null, text: 'four', noSync: false, labels: {}, createdAt: '', error: null }
    const other: store.Pending = { ...post, key: 'k2', text: 'five' }
    let state: store.State = { ...start, pending: [post, other] }
    state = store.applyEvent(state, postedEvent(message(17, { text: 'four' })))
    expect(state.pending.map((p) => p.key)).toEqual(['k2'])
    expect(store.channelThreads(state, 'ops').threads.map((t) => t.root.text)).toEqual(['four'])
    // Someone else's identical message isn't yours.
    state = store.applyEvent(
      state,
      postedEvent(message(18, { text: 'five', by: { actor: 'slack:user:U1', principal: 'slack:user:U1', profile: null, session: null } })),
    )
    expect(state.pending.map((p) => p.key)).toEqual(['k2'])
  })

  it('filters like the board: source, text, and labels on the message or its root', () => {
    const state = store.merge(
      start,
      [
        message(1, { labels: { pr: 'x/y#1', state: 'open' }, from: 'github' }),
        message(2, { re: '1', text: 'Flaky test', from: 'slack' }),
        message(3, { labels: { state: 'draft' } }),
      ],
    )
    const ids = (filter: Partial<store.Filter>) =>
      Object.values(state.messages)
        .filter((m) => store.matches(state, m, { label: [], ...filter }))
        .map((m) => m.id)
    expect(ids({ label: ['pr'] })).toEqual(['1', '2'])
    expect(ids({ label: ['state=open|draft'] })).toEqual(['1', '2', '3'])
    expect(ids({ label: ['pr=x/y#1'], text: 'flaky' })).toEqual(['2'])
    expect(ids({ from: 'board' })).toEqual(['3'])
    expect(store.filtering({ label: [] })).toBe(false)
  })

  it('groups messages by author, place, and time', () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString()
    const first = message(1, { createdAt: at(0) })
    expect(continues(first, message(2, { createdAt: at(4) }))).toBe(true)
    expect(continues(first, message(2, { createdAt: at(6) }))).toBe(false) // too late
    expect(continues(first, message(2, { createdAt: at(1), channel: 'other' }))).toBe(false) // elsewhere
    expect(continues(first, message(2, { createdAt: at(1), re: '9' }))).toBe(false) // another thread
    expect(continues(first, message(2, { createdAt: at(1) }), true)).toBe(false) // the first has replies
  })

  it('groups a channel into threads, with pending posts', () => {
    let state = store.merge(start, [message(1), message(2, { re: '1' }), message(3), message(4, { channel: 'other' })])
    state = { ...state, pending: [{ key: 'k', channel: 'ops', re: '3', text: 'soon', noSync: false, labels: {}, createdAt: '', error: null }] }
    const { threads } = store.channelThreads(state, 'ops')
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id), t.pending.length])).toEqual([
      ['1', ['2'], 0],
      ['3', [], 1],
    ])
    expect(store.thread(state, '1')!.replies.map((r) => r.id)).toEqual(['2'])
    expect(store.recent(state, 2).map((m) => m.id)).toEqual(['3', '4'])
  })
})
