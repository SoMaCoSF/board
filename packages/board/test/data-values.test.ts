import { describe, expect, it } from 'vitest'
import { BUILT_IN_SCHEMAS } from '../src/contract/data-schemas.ts'
import { checkValue } from '../src/contract/data-values.ts'

/** What a sandbox did: a union of two shapes, told apart by `action`. */
const SANDBOX = {
  type: 'object',
  oneOf: [
    { type: 'object', required: ['id', 'action', 'config'], properties: { id: { type: 'string' }, action: { const: 'started' }, config: { type: 'object', properties: { vcpus: { type: 'integer', minimum: 1 } } } } },
    { type: 'object', required: ['id', 'action'], properties: { id: { type: 'string' }, action: { const: 'stopped' } } },
  ],
}

const ok = (schema: Record<string, unknown>, value: unknown) => checkValue(schema, value) === null

describe('a value against a schema', () => {
  it('takes each shape of a union, and refuses what is neither', () => {
    expect(checkValue(SANDBOX, { id: 'sbx-1', action: 'started', config: { vcpus: 4 } })).toBeNull()
    expect(checkValue(SANDBOX, { id: 'sbx-1', action: 'stopped' })).toBeNull()
    expect(ok(SANDBOX, { id: 'sbx-1', action: 'boot' })).toBe(false)
    expect(ok(SANDBOX, { id: 'sbx-1', action: 'started' })).toBe(false)
    expect(ok(SANDBOX, { id: 7, action: 'stopped' })).toBe(false)
    expect(ok(SANDBOX, { id: 'sbx-1', action: 'started', config: { vcpus: 0 } })).toBe(false)
    expect(ok(SANDBOX, 'sbx-1')).toBe(false)
  })

  it('says what is wrong of the field it is wrong in', () => {
    const schema = {
      type: 'object',
      required: ['id', 'action'],
      additionalProperties: false,
      properties: { id: { type: 'string' }, action: { enum: ['started', 'stopped'] }, config: { type: 'object', properties: { vcpus: { type: 'integer' }, tags: { type: 'array', items: { type: 'string', maxLength: 3 } } } } },
    }
    expect(checkValue(schema, { id: 'sbx-1', action: 'boot' })).toBe('action must be "started" or "stopped"')
    expect(checkValue(schema, { action: 'started' })).toBe('id is missing')
    expect(checkValue(schema, { id: 'sbx-1', action: 'started', config: { vcpus: 1.5 } })).toBe('config.vcpus must be an integer')
    expect(checkValue(schema, { id: 'sbx-1', action: 'started', config: { tags: ['a', 'toolong'] } })).toBe('config.tags[1] must be at most 3 characters')
    expect(checkValue(schema, { id: 'sbx-1', action: 'started', extra: true })).toBe("extra isn't one of its fields")
    expect(checkValue(schema, [])).toBe('it must be an object')
  })

  it('tells an integer from a number, and null, an array, and an object from each other', () => {
    const typed = (type: unknown) => ({ type: 'object', properties: { v: { type } } })
    const takes = (type: unknown, values: unknown[]) => values.map((v) => ok(typed(type), { v }))
    const values = [1, 1.5, '1', true, null, [], {}]
    expect(takes('integer', values)).toEqual([true, false, false, false, false, false, false])
    expect(takes('number', values)).toEqual([true, true, false, false, false, false, false])
    expect(takes('string', values)).toEqual([false, false, true, false, false, false, false])
    expect(takes('boolean', values)).toEqual([false, false, false, true, false, false, false])
    expect(takes('null', values)).toEqual([false, false, false, false, true, false, false])
    expect(takes('array', values)).toEqual([false, false, false, false, false, true, false])
    expect(takes('object', values)).toEqual([false, false, false, false, false, false, true])
    expect(takes(['string', 'null'], values)).toEqual([false, false, true, false, true, false, false])
  })

  it('holds each bound: lengths in characters, counts, and numbers', () => {
    const field = (rule: Record<string, unknown>) => ({ type: 'object', properties: { v: rule } })
    const takes = (rule: Record<string, unknown>, values: unknown[]) => values.map((v) => ok(field(rule), { v }))
    // An emoji is one character, though two UTF-16 units.
    expect(takes({ type: 'string', minLength: 2, maxLength: 3 }, ['a', 'ab', 'abc', 'abcd', '😀', '😀😀😀'])).toEqual([false, true, true, false, false, true])
    expect(takes({ type: 'array', minItems: 1, maxItems: 2 }, [[], [1], [1, 2], [1, 2, 3]])).toEqual([false, true, true, false])
    expect(takes({ type: 'number', minimum: 1, maximum: 3 }, [0.9, 1, 3, 3.1])).toEqual([false, true, true, false])
    expect(takes({ type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 3 }, [1, 1.1, 2.9, 3])).toEqual([false, true, true, false])
    expect(takes({ type: 'number', multipleOf: 0.5 }, [1, 1.5, 1.25, 0])).toEqual([true, true, false, true])
    // A bound on one type says nothing of a value of another.
    expect(takes({ minLength: 5, minimum: 5, minItems: 5 }, ['a', 1, []])).toEqual([false, false, false])
    expect(takes({ minLength: 5 }, [1, [], null])).toEqual([true, true, true])
  })

  it('compares fixed values as JSON: an object whatever order its keys come in', () => {
    const schema = { type: 'object', properties: { v: { enum: [{ a: 1, b: [1, 2] }, 'x', null, 2] }, w: { const: { k: [true, { n: null }] } } } }
    expect(ok(schema, { v: { b: [1, 2], a: 1 }, w: { k: [true, { n: null }] } })).toBe(true)
    expect(ok(schema, { v: null })).toBe(true)
    expect(ok(schema, { v: { a: 1, b: [2, 1] } })).toBe(false)
    expect(ok(schema, { v: { a: 1, b: [1, 2], c: 3 } })).toBe(false)
    expect(ok(schema, { v: '2' })).toBe(false)
    expect(ok(schema, { w: { k: [true, {}] } })).toBe(false)
  })

  it('combines schemas: all of, any of, exactly one of, and not', () => {
    const field = (rule: Record<string, unknown>) => ({ type: 'object', properties: { v: rule } })
    const takes = (rule: Record<string, unknown>, values: unknown[]) => values.map((v) => ok(field(rule), { v }))
    const [small, even] = [{ type: 'integer', maximum: 10 }, { type: 'integer', multipleOf: 2 }]
    expect(takes({ allOf: [small, even] }, [4, 5, 12])).toEqual([true, false, false])
    expect(takes({ anyOf: [small, even] }, [4, 5, 12, 13])).toEqual([true, true, true, false])
    // Exactly one: 4 is both, so it's neither's.
    expect(takes({ oneOf: [small, even] }, [4, 5, 12, 13])).toEqual([false, true, true, false])
    expect(takes({ not: even }, [4, 5, 'x'])).toEqual([false, true, true])
    expect(takes({ oneOf: [true, false] }, [1])).toEqual([true])
    expect(takes({ anyOf: [false] }, [1])).toEqual([false])
  })

  it('checks every item of an array, and fields a schema names no property for', () => {
    const schema = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, additionalProperties: { type: 'number' } }
    expect(ok(schema, { list: [{ name: 'a' }, { name: 'b', more: 1 }], count: 2 })).toBe(true)
    expect(checkValue(schema, { list: [{ name: 'a' }, {}] })).toBe('list[1].name is missing')
    expect(checkValue(schema, { count: 'two' })).toBe('count must be a number')
    // A field named like something every object has is a field like any other.
    expect(ok({ type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } }, JSON.parse('{"id":"a","__proto__":1}'))).toBe(false)
    expect(ok({ type: 'object', required: ['constructor'] }, {})).toBe(false)
  })

  it('reads each format as its standard writes it', () => {
    const takes = (format: string, values: string[]) => values.map((v) => ok({ type: 'object', properties: { v: { type: 'string', format } } }, { v }))
    expect(takes('date', ['2026-11-10', '2024-02-29', '2026-02-29', '2026-13-01', '26-11-10'])).toEqual([true, true, false, false, false])
    expect(takes('time', ['10:20:30Z', '10:20:30.5+02:00', '10:20:30', '24:00:00Z', '10:20Z'])).toEqual([true, true, true, false, false])
    expect(takes('date-time', ['2026-11-10T10:20:30Z', '2026-11-10T10:20:30.123-03:00', '2026-11-10', '2026-02-30T10:20:30Z', 'yesterday'])).toEqual([true, true, false, false, false])
    expect(takes('email', ['ada@acme.com', 'ada.l+board@mail.acme.com', 'ada@acme', '@acme.com', 'a b@acme.com'])).toEqual([true, true, false, false, false])
    expect(takes('uri', ['https://vercel.com/x?y=1#z', 'mailto:ada@acme.com', '/relative', 'no scheme', 'https://exa mple.com'])).toEqual([true, true, false, false, false])
    expect(takes('uuid', ['123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000', '123e4567e89b12d3a456426614174000', 'not-a-uuid'])).toEqual([true, true, false, false])
    expect(takes('hostname', ['vercel.com', 'a-b.c', '-a.com', 'a..b', 'exa_mple.com'])).toEqual([true, true, false, false, false])
    expect(takes('ipv4', ['1.2.3.4', '255.255.255.255', '256.1.1.1', '1.2.3'])).toEqual([true, true, false, false])
    expect(takes('ipv6', ['::1', '2001:db8::8a2e:370:7334', '::ffff:1.2.3.4', '1:2:3:4:5:6:7', '1::2::3', 'g::1'])).toEqual([true, true, true, false, false, false])
    // A format is a string's: another type has none to fail.
    expect(ok({ type: 'object', properties: { v: { format: 'date' } } }, { v: 7 })).toBe(true)
  })

  it("checks the built-ins, which use a pattern no registered schema can", () => {
    const [commit, deployment, standing] = BUILT_IN_SCHEMAS.map((schema) => schema.schema)
    const sha = 'a'.repeat(40)
    expect(ok(commit!, { sha, title: 'fix the build' })).toBe(true)
    expect(ok(commit!, { sha: 'abc123', title: 'fix the build' })).toBe(false)
    expect(ok(commit!, { sha: sha.toUpperCase(), title: 'fix the build' })).toBe(false)
    expect(ok(commit!, { sha, title: '' })).toBe(false)
    expect(ok(commit!, { sha, title: 'fix', author: 'ada' })).toBe(false)
    expect(ok(deployment!, { url: 'https://board-abc.vercel.app', gitSha: sha })).toBe(true)
    expect(ok(deployment!, { url: 'http://board-abc.vercel.app' })).toBe(false)
    expect(ok(deployment!, {})).toBe(false)
    // Deployments, each with where it stands: a pull request's, say.
    const url = 'https://board-abc.vercel.app'
    const board = { project: 'board', state: 'ready' }
    for (const state of ['queued', 'building', 'ready', 'error', 'canceled']) expect(ok(standing!, { deployments: [{ project: 'board', state }] })).toBe(true)
    expect(
      ok(standing!, {
        gitSha: sha,
        deployments: [
          { ...board, url, environment: 'preview', inspectorUrl: 'https://vercel.com/acme/board/abc', projectUrl: 'https://vercel.com/acme/board', updatedAt: '2026-11-12T21:30:00Z' },
          { project: 'docs', state: 'building', url: 'https://docs-abc.vercel.app' },
        ],
      }),
    ).toBe(true)
    expect(checkValue(standing!, { deployments: [{ project: 'board' }] })).toBe('deployments[0].state is missing')
    expect(checkValue(standing!, { deployments: [board, { url, state: 'ready' }] })).toBe('deployments[1].project is missing')
    expect(checkValue(standing!, { deployments: [board, { ...board, state: 'READY' }] })).toMatch(/^deployments\[1\]\.state must be /)
    expect(ok(standing!, { deployments: [] })).toBe(false)
    expect(ok(standing!, {})).toBe(false)
    expect(ok(standing!, { deployments: [{ ...board, project: '' }] })).toBe(false)
    for (const field of ['url', 'inspectorUrl', 'projectUrl']) expect([field, ok(standing!, { deployments: [{ ...board, [field]: 'http://vercel.com/acme/board' }] })]).toEqual([field, false])
    expect(ok(standing!, { deployments: [{ ...board, updatedAt: 'two hours ago' }] })).toBe(false)
    expect(ok(standing!, { deployments: [{ ...board, gitSha: sha }] })).toBe(false)
    expect(ok(standing!, { deployments: Array.from({ length: 51 }, () => board) })).toBe(false)
  })
})
