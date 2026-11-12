import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import { block } from '../src/contract/blocks.ts'
import { as, fakeMessageboard } from './messageboard.ts'

const API = 'http://localhost'

/** A handle on one of the fake team's boards through vercel(), as `principal`: its default board unless `on` names another by ID. */
const handleOn = (api: ReturnType<typeof fakeMessageboard>, principal = 'user:u_jb', on?: string) =>
  board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, principal), files: api.files, ...(on ? { board: on } : {}) }) })

const SANDBOX = { type: 'object', required: ['id', 'action'], properties: { id: { type: 'string' }, action: { enum: ['started', 'stopped'] } } }

describe("vercel() and the team's schemas", () => {
  it("registers a version in the team's registry, once, and gives back the API's answer as the protocol has it", async () => {
    const api = fakeMessageboard({ boards: [{ name: 'security', id: 'brd_sec' }] })
    const team = handleOn(api)
    const made = await team.createSchema({ name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX })
    // What the API was sent, and kept.
    const kept = api.schemas.get('sandbox@1')!
    expect(kept).toMatchObject({ name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX })
    // Its milliseconds and its actor, as a board says when and who.
    expect(made).toEqual({
      created: true,
      schema: { id: 'sandbox@1', name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX, builtIn: false, by: kept.createdBy!.id, at: new Date(kept.createdAt).toISOString() },
    })
    expect(kept.createdBy).toMatchObject({ principal: { type: 'user', userId: 'u_jb' } })

    // The same again makes nothing, and says so, as the API said.
    expect(await team.createSchema({ name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX })).toEqual({ created: false, schema: made.schema })
    expect([...api.schemas.keys()]).toEqual(['sandbox@1'])
    // One request each: registering reads nothing first.
    expect(api.requests.filter((request) => request.includes('/schemas'))).toEqual(['POST /schemas', 'POST /schemas'])

    // One registry for the team: another of its boards has it too.
    expect(await handleOn(api, 'user:u_jb', 'brd_sec').schema('sandbox@1')).toEqual(made.schema)
    // A built-in has no one behind it, and no time.
    expect(await team.schema('git-commit@1')).toMatchObject({ builtIn: true, by: null, at: null, description: 'A Git commit, by its full SHA and the first line of its message.' })
  })

  it('tells two that register one version at once which of them made it', async () => {
    const api = fakeMessageboard()
    const body = { name: 'sandbox', version: 1, schema: SANDBOX }
    const both = await Promise.all([handleOn(api).createSchema(body), handleOn(api, 'user:u_ada').createSchema(body)])
    expect(both.map(({ created }) => created).sort()).toEqual([false, true])
    expect(both[0]!.schema).toEqual(both[1]!.schema)
  })

  it("lists the team's own by name, then version as a number, where the API lists them by ID as text", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    for (const [name, version] of [['sandbox', 2], ['sandbox', 10], ['incident.finding', 1]] as const) await team.createSchema({ name, version, schema: { type: 'object' } })
    // As the API has them: sandbox@10 before sandbox@2.
    expect([...api.schemas.keys()].sort()).toEqual(['incident.finding@1', 'sandbox@10', 'sandbox@2'])
    expect((await team.schemas()).map((schema) => schema.id)).toEqual(['git-commit@1', 'vercel-deployment@1', 'incident.finding@1', 'sandbox@2', 'sandbox@10'])
    expect((await team.schema('sandbox@10')).description).toBeNull()
  })

  it("leaves registering to people and apps, and lets whoever the board lets in read: a viewer and a project's own credentials register none, and list them", async () => {
    const api = fakeMessageboard()
    const body = { name: 'sandbox', version: 1, schema: SANDBOX }
    const builtIns = ['git-commit@1', 'vercel-deployment@1']
    await expect(handleOn(api, 'user:u_val').createSchema(body)).rejects.toMatchObject({ status: 403 })
    expect((await handleOn(api, 'user:u_val').schemas()).map((schema) => schema.id)).toEqual(builtIns)
    const deployment = handleOn(api, 'project:prj_pong:production')
    await expect(deployment.createSchema(body)).rejects.toMatchObject({ status: 403 })
    expect([...api.schemas.keys()]).toEqual([])
    // It reads them through its board: the team's own routes answer a project 403.
    expect((await deployment.schemas()).map((schema) => schema.id)).toEqual(builtIns)
    expect(await deployment.schema('git-commit@1')).toMatchObject({ id: 'git-commit@1', builtIn: true })
    // What the API says of a definition is what the caller hears.
    await expect(handleOn(api).createSchema({ name: 'sandbox', version: 1, schema: { type: 'object', properties: { next: { $ref: '#' } } } })).rejects.toMatchObject({ status: 400, code: 'invalid_schema' })
    await expect(handleOn(api).schema('sandbox@1')).rejects.toMatchObject({ status: 404, code: 'schema_not_found' })
    await expect(deployment.schema('sandbox@1')).rejects.toMatchObject({ status: 404, code: 'schema_not_found' })
  })

  it("checks a block before it reaches Vercel's API, which keeps text alone, and reads its blocks out of that text", async () => {
    const api = fakeMessageboard()
    const team = handleOn(api)
    await team.createSchema({ name: 'sandbox', version: 1, schema: SANDBOX })
    const writes = () => api.requests.filter((request) => request.startsWith('POST') && request.includes('/boards/')).length

    const before = writes()
    await expect(team.post('deploys', block('sandbox@1', { id: 'sbx-9', action: 'boot' }))).rejects.toMatchObject({ status: 400, code: 'invalid_block' })
    await expect(team.post('deploys', block('sandbox@2', { id: 'sbx-9', action: 'started' }))).rejects.toMatchObject({ status: 400, code: 'schema_not_found' })
    // Neither went to the API.
    expect(writes()).toBe(before)

    const posted = await team.post('deploys', `sandbox sbx-9 started\n\n${block('sandbox@1', { id: 'sbx-9', action: 'started' })}`)
    expect(posted.blocks).toEqual([{ schema: 'sandbox', version: 1, data: { id: 'sbx-9', action: 'started' } }])
    expect((await team.thread(posted.id)).message.blocks).toEqual(posted.blocks)
    await expect(team.edit(posted.id, block('sandbox@1', { id: 'sbx-9' }))).rejects.toMatchObject({ status: 400, code: 'invalid_block' })
    expect((await team.thread(posted.id)).message.blocks).toEqual(posted.blocks)
  })

  it("checks a deployment's block there as anyone's: it reads the schema the block names through its board", async () => {
    const api = fakeMessageboard()
    await handleOn(api).createSchema({ name: 'sandbox', version: 1, schema: SANDBOX })
    const deployment = handleOn(api, 'project:prj_pong:production')
    const posted = await deployment.post('deploys', block('sandbox@1', { id: 'sbx-9', action: 'started' }))
    expect(posted.blocks).toEqual([{ schema: 'sandbox', version: 1, data: { id: 'sbx-9', action: 'started' } }])
    await expect(deployment.post('deploys', block('sandbox@1', { id: 'sbx-9', action: 'boot' }))).rejects.toMatchObject({ status: 400, code: 'invalid_block' })
    await expect(deployment.post('deploys', block('sandbox@2', { id: 'sbx-9', action: 'started' }))).rejects.toMatchObject({ status: 400, code: 'schema_not_found' })
  })

  it('shows no blocks for what a sync brought in there either', async () => {
    const api = fakeMessageboard()
    await handleOn(api).createSchema({ name: 'sandbox', version: 1, schema: SANDBOX })
    const sync = handleOn(api, 'project:prj_pong:production')
    await sync.register({ url: null, watch: {}, sync: [{ key: 'reviews', platform: 'github' }] })
    const author = { id: 'reviews:user:9', handle: 'ada', name: 'Ada', avatar: null, isBot: false }
    const origin = { thread: 'reviews:acme/web:1', subthread: null, message: '1', context: null }
    const text = block('sandbox@1', { id: 'sbx-9', action: 'started' })
    const { message } = await sync.syncImport({ op: 'post', author, from: 'reviews', channel: 'deploys', text, origin })
    // It came through the project's own sync key, so it's a platform's text, whatever it says.
    expect((await handleOn(api).thread(message!)).message).toMatchObject({ text, from: 'pong/reviews', blocks: [] })
  })
})
