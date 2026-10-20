import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { foldSubscriptions, subscriptionOf, subscriptionsReducer, type SubscriptionsState } from '../src/contract/reducers.ts'
import { caller, personToken, testBoard } from './harness.ts'

async function setup() {
  const instance = testBoard({ agents: { helper: { name: 'Helper' } } })
  const julian = caller(instance.fetch, await personToken(), { 'x-board-handle': 'julian' })
  const post = async (body: Record<string, unknown>) => (await julian('POST', '/messages', body)).body.message as MessageView
  const following = async (thread: string) => (await instance.session.state(subscriptionsReducer)).state[thread] ?? {}
  return { instance, julian, post, following }
}

describe('thread subscriptions', () => {
  it('follow a thread for an agent that is mentioned in it or posts in it', async () => {
    const { instance, post, following } = await setup()
    const mentioned = await post({ channel: 'dev', text: '@helper look' })
    expect(await following(mentioned.thread)).toEqual({ 'vboard:agent:helper': { subscribed: true, chosen: false } })

    const quiet = await post({ channel: 'dev', text: 'no one called' })
    expect(await following(quiet.thread)).toEqual({})
    await instance.agent('helper').reply(quiet.id, { text: 'I can help' })
    expect(await following(quiet.thread)).toEqual({ 'vboard:agent:helper': { subscribed: true, chosen: false } })
  })

  it('remember which of an agent’s sessions last took part in a thread', async () => {
    const { instance, post, following } = await setup()
    const root = await post({ channel: 'dev', text: '@helper look' })
    expect(await following(root.thread)).toEqual({ 'vboard:agent:helper': { subscribed: true, chosen: false } })

    await instance.agent('helper', { session: 'thread-1' }).reply(root.id, { text: 'on it' })
    expect((await following(root.thread))['vboard:agent:helper']).toMatchObject({ session: 'thread-1' })
    await instance.agent('helper', { session: 'main' }).reply(root.id, { text: 'taking this over' })
    expect((await following(root.thread))['vboard:agent:helper']).toMatchObject({ session: 'main' })
    // Someone else's reply doesn't move it.
    await post({ re: root.id, text: 'thanks' })
    expect((await following(root.thread))['vboard:agent:helper']).toMatchObject({ session: 'main' })
  })

  it('keep an agent’s own choice: a later mention doesn’t follow a thread it left', async () => {
    const { instance, post, following } = await setup()
    const root = await post({ channel: 'dev', text: '@helper look' })
    expect(await instance.agent('helper').unsubscribe(root.id)).toEqual({ root: root.id, subscribed: false })

    await post({ re: root.id, text: '@helper again?' })
    expect(await following(root.thread)).toEqual({ 'vboard:agent:helper': { subscribed: false, chosen: true } })
    expect(await instance.agent('helper').subscribe(root.id)).toEqual({ root: root.id, subscribed: true })
  })

  it('are anyone’s to choose, by any message in the thread', async () => {
    const { julian, post, following } = await setup()
    const root = await post({ channel: 'dev', text: 'deploy is slow' })
    const reply = await post({ re: root.id, text: 'still slow' })

    expect((await julian('POST', `/messages/${reply.id}/subscription`, { on: true })).body).toEqual({ root: root.id, subscribed: true })
    const [actor] = Object.keys(await following(root.thread))
    expect(actor).toMatch(/^vercel:user:/)
    expect((await julian('POST', `/messages/${root.id}/subscription`, { on: false })).body).toEqual({ root: root.id, subscribed: false })
    expect((await julian('POST', `/messages/${root.id}/subscription`, { on: 'yes' })).status).toBe(400)
  })

  it('keep every thread key to itself, even one named like a prototype', async () => {
    const { julian } = await setup()
    for (const id of ['__proto__', 'constructor', 'toString'])
      expect((await julian('POST', '/messages', { channel: 'dev', text: '@helper hi', id })).body.error).toMatchObject({ code: 'invalid_request' })

    const by = { actor: 'vboard:agents', principal: 'vboard:agents', profile: null, session: null }
    const event = (thread: string) =>
      ({ type: 'thread.subscribed', payload: { thread, actor: 'vboard:agent:helper', cause: 'mention', by } }) as Parameters<typeof foldSubscriptions>[1]
    const state = foldSubscriptions(foldSubscriptions({} as SubscriptionsState, event('__proto__')), event('t1'))
    expect(({} as Record<string, unknown>)['vboard:agent:helper']).toBeUndefined()
    expect(subscriptionOf(state, '__proto__', 'vboard:agent:helper')).toEqual({ subscribed: true, chosen: false })
    expect(subscriptionOf(state, 'other', 'vboard:agent:helper')).toBeUndefined()
    expect(subscriptionOf(state, 't1', 'toString')).toBeUndefined()
  })
})
