import { describe, expect, it } from 'vitest'
import type { BoardEventView, MessageView } from '../src/api/routes.ts'
import { parseScope } from '../src/server/access.ts'
import * as store from '../src/inspect/app/store.ts'
import { caller, personToken, testBoard } from './harness.ts'

describe('names Object.prototype also has', () => {
  it('react as `constructor` and `__proto__` without stopping the board', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const { id } = (await julian('POST', '/messages', { channel: 'x', text: 'hi' })).body.message
    for (const emoji of ['constructor', '__proto__']) {
      expect((await julian('POST', `/messages/${id}/reactions`, { emoji })).status).toBe(200)
    }
    const after = await julian('POST', '/messages', { channel: 'x', text: 'still here' })
    expect(after.status).toBe(201)
    const read = await julian('GET', `/messages/${id}`)
    expect(read.body.message.reactions).toEqual(Object.fromEntries([['constructor', ['vercel:user:u_julian']], ['__proto__', ['vercel:user:u_julian']]]))

    await julian('POST', `/messages/${id}/reactions`, { emoji: '__proto__', remove: true })
    expect((await julian('GET', `/messages/${id}`)).body.message.reactions).toEqual({ constructor: ['vercel:user:u_julian'] })
  })

  it('take the handle `constructor`, and mention and filter by it', async () => {
    const { fetch } = testBoard()
    const person = caller(fetch, await personToken('u_c'), { 'x-board-handle': 'constructor' })
    const julian = caller(fetch, await personToken('u_julian'), { 'x-board-handle': 'julian' })
    expect((await person('POST', '/messages', { channel: 'x', text: 'hello' })).status).toBe(201)
    expect((await person('POST', '/messages', { channel: 'x', text: 'again' })).status).toBe(201)

    const mention = await julian('POST', '/messages', { channel: 'x', text: 'hi @constructor' })
    expect(mention.body.message.mentions).toEqual(['vercel:user:u_c'])
    const phantom = await julian('POST', '/messages', { channel: 'x', text: '@[constructor]' })
    expect(phantom.body.error.code).toBe('unknown_mention')

    const by = await julian('GET', '/events?by=constructor&after=0')
    expect(by.body.events.map((e: BoardEventView) => e.message?.text)).toEqual(['hello', 'again'])
    expect((await julian('GET', '/events?by=__proto__&after=0')).body.events).toEqual([])
  })

  it('count a channel named `constructor`', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    const { id } = (await julian('POST', '/messages', { channel: 'constructor', text: 'one' })).body.message
    await julian('POST', '/messages', { re: id, text: 'two' })
    expect((await julian('GET', '/channels')).body.channels).toEqual([
      { path: 'constructor', lastIndex: id + 1, messages: 2, threads: 1 },
    ])
  })

  it('match the label `constructor` only where it is set', async () => {
    const { fetch } = testBoard()
    const julian = caller(fetch, await personToken())
    await julian('POST', '/messages', { channel: 'x', text: 'plain' })
    await julian('POST', '/messages', { channel: 'x', text: 'tagged', labels: { constructor: 'yes' } })
    const events = await julian('GET', '/events?label=constructor&after=0')
    expect(events.body.events.map((e: BoardEventView) => e.message?.text)).toEqual(['tagged'])
  })

  it('scope a channel named `constructor`', () => {
    expect(parseScope('constructor=read')).toEqual({ constructor: ['read'] })
  })

  it('in the inspector, confirm, count, and filter them', () => {
    const ME = 'vercel:user:u_julian'
    const view = (overrides: Partial<MessageView>): MessageView => ({
      id: 1,
      channel: 'constructor',
      text: 'hi',
      re: null,
      replyTo: null,
      thread: 't1',
      labels: {},
      reactions: {},
      mentions: [],
      by: { actor: ME, principal: ME, profile: null, session: null },
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
    })
    const plain = view({})
    expect(store.confirms(plain, { kind: 'label', set: {}, unset: ['constructor'] }, ME)).toBe(true)
    expect(store.confirms(plain, { kind: 'react', emoji: 'constructor', remove: true }, ME)).toBe(true)
    expect(store.apply(plain, { kind: 'react', emoji: '__proto__', remove: false }, ME, '').reactions).toEqual(Object.fromEntries([['__proto__', [ME]]]))
    expect(store.matches(store.initialState, plain, { label: ['constructor'] })).toBe(false)

    const posted = store.applyEvent(store.initialState, { index: 1, type: 'message.posted', createdAt: '', payload: {}, message: plain } as BoardEventView)
    expect(posted.channels).toEqual({ constructor: { path: 'constructor', lastIndex: 1, messages: 1, threads: 1 } })
  })
})
