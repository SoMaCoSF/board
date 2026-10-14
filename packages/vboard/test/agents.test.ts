import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { actorsReducer } from '../src/contract/reducers.ts'
import { board } from '../src/server/index.ts'
import { BOARD_URL, caller, deploymentToken, personToken, PROJECT_ID, testBoard } from './harness.ts'

const own = (environment = 'production') => deploymentToken('board', PROJECT_ID, environment)

afterEach(() => vi.unstubAllEnvs())

describe('declared agents', () => {
  it('are who the board’s own deployment writes as, by profile', async () => {
    const { fetch } = testBoard({ agents: { helper: { name: 'Helper' } } })
    const helper = caller(fetch, await own(), { 'x-board-profile': 'helper' })
    const { status, body } = await helper('POST', '/messages', { channel: 'dev', text: 'hello' })

    expect(status).toBe(201)
    expect(body.message.by).toMatchObject({ actor: 'vboard:agent:helper', profile: 'helper' })
    expect(body.message.author).toMatchObject({ kind: 'agent', handle: 'helper', name: 'Helper' })
    expect((await helper('GET', '/me')).body).toMatchObject({ actor: 'vboard:agent:helper' })
  })

  it('are no one else’s: a person, another environment, and an undeclared key get a profile of their own', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const { fetch } = testBoard({ agents: { helper: {} } })
    const person = caller(fetch, await personToken(), { 'x-board-profile': 'helper' })
    const preview = caller(fetch, await own('preview'), { 'x-board-profile': 'helper' })
    const undeclared = caller(fetch, await own(), { 'x-board-profile': 'other' })

    for (const as of [person, preview]) {
      const { by } = (await as('POST', '/messages', { channel: 'dev', text: 'hi' })).body.message as MessageView
      expect(by.actor).not.toBe('vboard:agent:helper')
      expect(by.actor).toMatch(/\+helper$/)
    }
    const { by } = (await undeclared('POST', '/messages', { channel: 'dev', text: 'hi' })).body.message as MessageView
    expect(by.actor).toMatch(/\+other$/)
  })

  it('are listed and mentionable before they write, and stored by ID', async () => {
    const instance = testBoard({ agents: { helper: { name: 'Helper' } } })
    const julian = caller(instance.fetch, await personToken(), { 'x-board-handle': 'julian' })

    expect((await julian('GET', '/actors')).body.actors).toContainEqual(expect.objectContaining({ id: 'vboard:agent:helper', handle: 'helper', name: 'Helper' }))
    const message = (await julian('POST', '/messages', { channel: 'dev', text: '@helper look' })).body.message as MessageView
    expect(message).toMatchObject({ text: '@[vboard:agent:helper] look', mentions: ['vboard:agent:helper'] })
    expect(message.mentioned).toEqual({ 'vboard:agent:helper': { handle: 'helper', name: 'Helper' } })

    const { state } = await instance.session.state(actorsReducer)
    expect(state.byId['vboard:agent:helper']).toBeUndefined()
    await instance.agent('helper').reply(message.id, { text: 'on it' })
    expect((await instance.session.state(actorsReducer)).state.byId['vboard:agent:helper']).toMatchObject({ kind: 'agent', name: 'Helper' })
  })

  it('write in process with board.agent(), idempotently with a key', async () => {
    const instance = testBoard({ agents: { helper: {} } })
    const first = await instance.agent('helper', { key: 'call-1', session: 'thread-9' }).post('dev', { text: 'once' })
    const again = await instance.agent('helper', { key: 'call-1', session: 'thread-9' }).post('dev', { text: 'once' })

    expect(again.id).toBe(first.id)
    expect(first.by).toMatchObject({ actor: 'vboard:agent:helper', session: 'thread-9' })
    expect(() => instance.agent('nope')).toThrow('agent: no agent named nope')
  })

  it('edit what the agent wrote, however it wrote it; no one else does', async () => {
    const instance = testBoard({ agents: { helper: {} } })
    const helper = caller(instance.fetch, await own(), { 'x-board-profile': 'helper' })
    const julian = caller(instance.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const posted = (await helper('POST', '/messages', { channel: 'dev', text: 'draft' })).body.message as MessageView

    expect((await julian('POST', `/messages/${posted.id}/edit`, { text: 'mine now' })).status).toBe(403)
    await instance.agent('helper').edit(posted.id, 'final')
    expect((await julian('GET', `/messages/${posted.id}`)).body.message.text).toBe('final')
    expect((await helper('POST', `/messages/${posted.id}/delete`, {})).status).toBe(200)
  })

  it('refuse a key, name, or avatar the board can’t use', () => {
    const declare = (agents: Record<string, { name?: string; avatar?: string }>) => board({ url: BOARD_URL, agents })
    expect(() => declare({ 'Bad Key': {} })).toThrow('agents: keys start with a letter')
    expect(() => declare({ helper: { name: ' ' } })).toThrow('agents helper: names are 1 to 128 characters')
    expect(() => declare({ helper: { avatar: 'http://example.com/a.png' } })).toThrow('agents helper: avatars must be https URLs')
  })
})
