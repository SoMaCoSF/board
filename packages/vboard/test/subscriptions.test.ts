import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { subscriptionsReducer } from '../src/contract/reducers.ts'
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
})
