import { describe, expect, it } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { caller, personToken, testBoard } from './harness.ts'

type Team = ReturnType<typeof testBoard>

/**
 * A board on a store where `write` lands just before the batch that posts `text` reaches it,
 * once: between a reply's look at its thread and its append, whatever the board does in between.
 */
function landingFirst(text: string, write: (team: Team) => Promise<unknown>) {
  const store = memory()
  const append = store.log.append.bind(store.log)
  const state = { landed: false }
  store.log.append = async (session, events, options) => {
    const posting = events.some((event) => event.type === 'message.posted' && (event.payload as { text?: string }).text === text)
    if (posting && !state.landed) {
      state.landed = true
      await write(team)
    }
    return append(session, events, options)
  }
  const team = testBoard({ store })
  return { team, state }
}

describe('a reply after a message, on a2()', () => {
  it('lands when the board moves on elsewhere between its check and its append', async () => {
    const { team, state } = landingFirst('on it', (team) => team.post('chatter', 'meanwhile, elsewhere'))
    const root = await team.post('deploys', 'deploy a1b2c3')
    const reply = await team.reply(root.id, { text: 'on it', after: root.id })
    expect(state.landed).toBe(true)
    expect((await team.thread(root.id)).replies.map((m) => m.id)).toEqual([reply.id])
  })

  it('is refused when a reply in its thread lands between its check and its append', async () => {
    let root = ''
    const { team, state } = landingFirst('on it', (team) => team.reply(root, 'me first'))
    root = (await team.post('deploys', 'deploy a1b2c3')).id
    await expect(team.reply(root, { text: 'on it', after: root })).rejects.toMatchObject({ status: 409, code: 'newer_message' })
    expect(state.landed).toBe(true)
    expect((await team.thread(root)).replies.map((m) => m.text)).toEqual(['me first'])
  })

  it('gives a retry with the same ID the reply that landed, whatever its `after` says now', async () => {
    const team = testBoard()
    const root = await team.post('deploys', 'deploy a1b2c3')
    const other = await team.post('deploys', 'deploy d4e5f6')
    const landed = await team.reply(root.id, { text: 'on it', id: 'step-1', after: root.id })
    await team.reply(root.id, 'me too')
    // An `after` that's stale, in another thread, or no message at all.
    for (const after of [root.id, other.id, 'not-a-message']) expect((await team.reply(root.id, { text: 'on it', id: 'step-1', after })).id).toBe(landed.id)
    await expect(team.reply(root.id, { text: 'on it', id: 'step-2', after: 'not-a-message' })).rejects.toMatchObject({ status: 400, code: 'invalid_after' })
    expect((await team.thread(root.id)).replies.map((m) => m.text)).toEqual(['on it', 'me too'])
  })

  it('lands once for the same request sent twice at once, and gives both the reply', async () => {
    let root = ''
    let first = ''
    // An agent's first write records who it is too, so the two batches aren't the same.
    const { team, state } = landingFirst('on it', async (team) => (first = (await team.as('claude').reply(root, { text: 'on it', id: 'step-1', after: root })).id))
    root = (await team.post('deploys', 'deploy a1b2c3')).id
    const again = await team.as('claude').reply(root, { text: 'on it', id: 'step-1', after: root })
    expect(state.landed).toBe(true)
    expect(again.id).toBe(first)
    expect((await team.thread(root)).replies.map((m) => m.id)).toEqual([first])
  })

  it('takes only a message in its own thread', async () => {
    const team = testBoard()
    const root = await team.post('deploys', 'deploy a1b2c3')
    const other = await team.post('deploys', 'deploy d4e5f6')
    await expect(team.reply(root.id, { text: 'on it', after: other.id })).rejects.toMatchObject({ status: 400, code: 'invalid_after' })
    await expect(team.reply(root.id, { text: 'on it', after: '999999' })).rejects.toMatchObject({ status: 400, code: 'invalid_after' })
    expect((await team.thread(root.id)).replies).toEqual([])
  })

  it("says the same for a message in a channel the caller can't read as for no message at all", async () => {
    const team = testBoard()
    const root = await team.post('deploys', 'deploy a1b2c3')
    const hidden = await team.post('secrets', 'rotate the keys')
    const narrowed = caller(team.fetch, await personToken(), { 'x-board-can': 'deploys=read,post' })
    const refused = async (after: string) => (await narrowed('POST', '/messages', { re: root.id, text: 'on it', after })).body
    const missing = await refused('999999')
    expect(missing).toMatchObject({ error: { code: 'invalid_after' } })
    expect(await refused(hidden.id)).toEqual(missing)
  })
})
