import { describe, expect, it } from 'vitest'
import { memory } from '../src/store/memory.ts'
import { caller, deploymentToken, personToken, testBoard, workflowToken } from './harness.ts'

/** What a sandbox did: a union of two shapes, told apart by `action`. */
const SANDBOX = {
  type: 'object',
  oneOf: [
    { type: 'object', required: ['id', 'action', 'config'], properties: { id: { type: 'string' }, action: { const: 'started' }, config: { type: 'object' } } },
    { type: 'object', required: ['id', 'action'], properties: { id: { type: 'string' }, action: { const: 'stopped' } } },
  ],
}

/** A board, Julian on it, and a way to call it with any token. */
async function setUp(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  const julian = caller(board.fetch, await personToken())
  const as = (token: string, headers: Record<string, string> = {}) => caller(board.fetch, token, headers)
  const register = (body: Record<string, unknown>, by = julian) => by('POST', '/schemas', body)
  return { board, julian, as, register }
}

const ids = (body: { schemas: { id: string }[] }) => body.schemas.map((schema) => schema.id)

describe('schemas', () => {
  it('starts with the built-ins, which no one registered, and reads one by its ID', async () => {
    const { julian } = await setUp()
    const { status, body } = await julian('GET', '/schemas')
    expect(status).toBe(200)
    expect(ids(body)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1'])
    expect(body.schemas[0]).toMatchObject({ name: 'git-commit', version: 1, builtIn: true, by: null, at: null, schema: { type: 'object', required: ['sha', 'title'] } })
    expect((await julian('GET', '/schemas/vercel-deployment@1')).body.schema).toEqual(body.schemas[1])
  })

  it('registers a version for good: the same definition again changes nothing, and another is refused', async () => {
    const { julian, register } = await setUp()
    const made = await register({ name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX })
    expect(made.status).toBe(200)
    expect(made.body).toMatchObject({
      created: true,
      schema: { id: 'sandbox@1', name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX, builtIn: false, by: 'vercel:user:u_julian' },
    })
    expect(Date.now() - Date.parse(made.body.schema.at)).toBeLessThan(60_000)

    // The same definition says the same whatever order its keys come in.
    const reordered = { oneOf: [...SANDBOX.oneOf].map(({ type, required, properties }) => ({ properties, required, type })), type: 'object' }
    expect((await register({ schema: reordered, description: 'What a sandbox did.', version: 1, name: 'sandbox' })).body).toEqual({ created: false, schema: made.body.schema })

    const changed = await register({ name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: { type: 'object', required: ['id'] } })
    expect(changed).toMatchObject({ status: 409, body: { error: { code: 'schema_immutable' } } })
    const redescribed = await register({ name: 'sandbox', version: 1, description: 'Something else.', schema: SANDBOX })
    expect(redescribed).toMatchObject({ status: 409, body: { error: { code: 'schema_immutable' } } })
    // It says which part differs: the same JSON Schema with another description isn't "another definition".
    expect(changed.body.error.message).toContain('another definition')
    expect(redescribed.body.error.message).toContain('another description')
    // What it was refused changed nothing.
    expect((await julian('GET', '/schemas/sandbox@1')).body.schema).toEqual(made.body.schema)

    // A changed definition is the next version, beside the first.
    expect((await register({ name: 'sandbox', version: 2, schema: { type: 'object', required: ['id'] } })).body).toMatchObject({ created: true, schema: { id: 'sandbox@2', description: null } })
    expect(ids((await julian('GET', '/schemas')).body)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1', 'sandbox@1', 'sandbox@2'])
  })

  it("lists the board's own after the built-ins, by name, then by version as a number", async () => {
    const { julian, register } = await setUp()
    for (const [name, version] of [['sandbox', 10], ['sandbox', 2], ['incident.finding', 1]] as const)
      expect((await register({ name, version, schema: { type: 'object' } })).status).toBe(200)
    expect(ids((await julian('GET', '/schemas')).body)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1', 'incident.finding@1', 'sandbox@2', 'sandbox@10'])
  })

  it('registers a version once when two register it at the same time', async () => {
    const { julian, register } = await setUp()
    const same = await Promise.all([1, 2, 3].map(() => register({ name: 'sandbox', version: 1, schema: SANDBOX })))
    expect(same.map((answer) => answer.status)).toEqual([200, 200, 200])
    expect(same.map((answer) => answer.body.created).sort()).toEqual([false, false, true])

    // Of two definitions for one version, one is kept and the other refused.
    const [a, b] = await Promise.all([{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }].map((schema) => register({ name: 'race', version: 1, schema })))
    expect([a!.status, b!.status].sort()).toEqual([200, 409])
    const kept = (a!.status === 200 ? a! : b!).body.schema
    expect((await julian('GET', '/schemas/race@1')).body.schema).toEqual(kept)
  })

  it('keeps what it registered in its log: a board on the same store has it', async () => {
    const store = memory()
    const first = await setUp({ store })
    const { body } = await first.register({ name: 'sandbox', version: 1, schema: SANDBOX })
    const second = await setUp({ store })
    expect((await second.julian('GET', '/schemas/sandbox@1')).body.schema).toEqual(body.schema)
    expect((await second.register({ name: 'sandbox', version: 1, schema: SANDBOX })).body.created).toBe(false)
  })

  it("takes manage at * to register, and lets anyone the board let in read them", async () => {
    const { julian, as, register } = await setUp()
    await julian('POST', '/grants', { principals: [{ kind: 'github', repository: 'acme/web' }], can: { 'ci/': ['read', 'post'] } })
    const narrowed = async (can: string) => as(await personToken(), { 'x-board-can': can })
    const body = { name: 'sandbox', version: 1, schema: SANDBOX }

    // A deployment starts with read, post, react, label, and sync: it posts data, and someone with manage says what data there is.
    const refused = [as(await deploymentToken()), as(await workflowToken()), await narrowed('dev/=all'), await narrowed('*=read,post,react,label,sync')]
    for (const caller of refused) {
      expect(await caller('POST', '/schemas', body)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
      expect(ids((await caller('GET', '/schemas')).body)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1'])
      expect((await caller('GET', '/schemas/git-commit@1')).status).toBe(200)
    }

    // A caller narrowed to manage on the whole board registers, as its principal.
    expect((await register(body, await narrowed('*=manage'))).body).toMatchObject({ created: true, schema: { by: 'vercel:user:u_julian' } })
    // And everyone reads what it registered.
    for (const caller of refused) expect((await caller('GET', '/schemas/sandbox@1')).body.schema.schema).toEqual(SANDBOX)
  })

  it("keeps the built-ins' names for the board: no one registers a version of one", async () => {
    const { julian, register } = await setUp()
    expect(await register({ name: 'git-commit', version: 2, schema: { type: 'object' } })).toMatchObject({ status: 409, body: { error: { code: 'reserved_schema' } } })
    expect(ids((await julian('GET', '/schemas')).body)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1'])
  })

  it('takes a definition it can check a value against: unions, enums, nesting, and formats', async () => {
    const { register } = await setUp()
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'Finding',
      type: 'object',
      additionalProperties: false,
      required: ['severity', 'where'],
      properties: {
        severity: { enum: ['low', 'high', null] },
        where: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'object', properties: { file: { type: 'string', maxLength: 500 }, line: { type: 'integer', minimum: 1 } } }] },
        tags: { type: 'array', maxItems: 8, items: { type: ['string', 'null'], minLength: 1 } },
        score: { type: 'number', exclusiveMinimum: 0, maximum: 10, multipleOf: 0.5 },
        open: { not: { const: false } },
        extra: true,
      },
    }
    expect((await register({ name: 'incident.finding', version: 1, schema })).body).toMatchObject({ created: true, schema: { schema } })
  })

  it("refuses a definition it couldn't check a value against, and keeps none of it", async () => {
    const { julian, register } = await setUp()
    const nested = (depth: number): Record<string, unknown> => (depth === 0 ? { type: 'string' } : { type: 'object', properties: { next: nested(depth - 1) } })
    const refused: Record<string, unknown> = {
      'no object': { type: 'string' },
      'no type': { properties: { id: { type: 'string' } } },
      'a reference': { type: 'object', properties: { next: { $ref: '#' } } },
      'a pattern': { type: 'object', properties: { id: { type: 'string', pattern: '^(a+)+$' } } },
      uniqueItems: { type: 'object', properties: { ids: { type: 'array', uniqueItems: true } } },
      'a keyword of its own': { type: 'object', 'x-view': { root: 'card' } },
      'a type that is none': { type: 'object', properties: { id: { type: 'text' } } },
      'an empty enum': { type: 'object', properties: { action: { enum: [] } } },
      'a schema per item': { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } },
      'a format it has no check for': { type: 'object', properties: { id: { type: 'string', format: 'regex' } } },
      'required that is no list of names': { type: 'object', required: 'id' },
      'a length below zero': { type: 'object', properties: { id: { type: 'string', minLength: -1 } } },
      'too many subschemas': { type: 'object', properties: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`p${index}`, { type: 'string' }])) },
      'too many values': { type: 'object', properties: { code: { enum: Array.from({ length: 600 }, (_, index) => index) } } },
      'too deep': nested(8),
      'too big': { type: 'object', description: 'x'.repeat(33_000) },
      'text the board cannot keep': { type: 'object', description: 'nul \u0000 here' },
    }
    for (const [what, schema] of Object.entries(refused))
      expect(await register({ name: 'refused', version: 1, schema }), what).toMatchObject({ status: 400, body: { error: { code: 'invalid_schema' } } })
    expect(ids((await julian('GET', '/schemas')).body)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1'])
    // As big as it gets is fine: 63 subschemas under the root, at the deepest level.
    expect((await register({ name: 'wide', version: 1, schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`p${index}`, { type: 'string' }])) } })).status).toBe(200)
    expect((await register({ name: 'deep', version: 1, schema: nested(7) })).status).toBe(200)
  })

  it('refuses a field it does not know, so nothing sent is dropped from a version that never changes', async () => {
    const { julian, register } = await setUp()
    expect(await register({ name: 'sandbox', version: 1, schema: SANDBOX, view: { root: 'card' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
    expect((await julian('GET', '/schemas/sandbox@1')).status).toBe(404)
  })

  it('names a version as name@version: a name in lowercase, and a version from 1', async () => {
    const { julian, register } = await setUp()
    for (const [name, version] of [['Sandbox', 1], ['1sandbox', 1], ['sandbox', 0], ['sandbox', 1.5], ['sandbox', 100_000], ['s'.repeat(81), 1]] as const)
      expect((await register({ name, version, schema: { type: 'object' } })).status, `${name}@${version}`).toBe(400)
    expect(await julian('GET', '/schemas/Sandbox')).toMatchObject({ status: 400, body: { error: { code: 'invalid_schema_id' } } })
    expect(await julian('GET', '/schemas/sandbox@0')).toMatchObject({ status: 400, body: { error: { code: 'invalid_schema_id' } } })
    expect(await julian('GET', '/schemas/sandbox@1')).toMatchObject({ status: 404, body: { error: { code: 'schema_not_found' } } })
    expect((await register({ name: 's'.repeat(80), version: 99_999, schema: { type: 'object' } })).status).toBe(200)
  })

  it('registers 500 versions, and no more', async () => {
    const { register } = await setUp()
    for (let version = 1; version <= 500; version++) expect((await register({ name: 'many', version, schema: { type: 'object' } })).status).toBe(200)
    expect(await register({ name: 'many', version: 501, schema: { type: 'object' } })).toMatchObject({ status: 400, body: { error: { code: 'too_many_schemas' } } })
    // One that's there is still answered: it adds nothing.
    expect((await register({ name: 'many', version: 7, schema: { type: 'object' } })).body.created).toBe(false)
  }, 60_000)

  it("registers from the board's own code, through its handle", async () => {
    const team = testBoard()
    const { schema, created } = await team.createSchema({ name: 'sandbox', version: 1, description: 'What a sandbox did.', schema: SANDBOX })
    expect({ created, id: schema.id, by: schema.by }).toEqual({ created: true, id: 'sandbox@1', by: 'board:client' })
    expect((await team.schemas()).map((found) => found.id)).toEqual(['git-commit@1', 'vercel-deployment@1', 'vercel-deployments@1', 'sandbox@1'])
    expect(await team.schema('sandbox@1')).toEqual(schema)
  })
})
