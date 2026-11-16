import ajv from 'ajv'
import ajvFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { checkDefinition, SCHEMA_FORMATS } from '../src/contract/data-schemas.ts'
import { checkValue } from '../src/contract/data-values.ts'

// `checkValue` against the validator Vercel's API checks a value with, set up as that API sets it
// up: a board anywhere and Vercel's give a value one answer. The versions are pinned in
// `devDependencies`: a format's edges moved between releases of ajv-formats.

/** Whether the reference takes `value` under `schema`, or null for a schema it won't compile. */
function reference(schema: Record<string, unknown>): ((value: unknown) => boolean) | null {
  // Both are CommonJS: their classes and functions are their modules' `default`.
  const validator = new ajv.default({ strict: true, allowUnionTypes: true, allErrors: false, logger: false })
  ajvFormats.default(validator, [...SCHEMA_FORMATS])
  try {
    const validate = validator.compile(schema)
    return (value) => validate(value) === true
  } catch {
    return null
  }
}

const x = (count: number) => 'x'.repeat(count)

/** What each format is asked about: what it ordinarily holds, and its edges. */
const SAMPLES: Record<(typeof SCHEMA_FORMATS)[number], string[]> = {
  date: ['2026-11-11', '2026-13-01', '2026-00-10', '2026-11-31', '2026-1-1', '02026-11-11', '2026-11-11T', '0000-01-01', '2100-02-29', '2000-02-29', '2024-02-29', '2026-11-00', '2026-04-31', '9999-12-31', '2026/11/11', ' 2026-11-11', '2026-11-11\n', ''],
  time: [
    '10:00:00', '10:00:00Z', '10:00:00z', '24:00:00Z', '10:00:60Z', '23:59:60Z', '23:59:60', '23:59:60+01:00', '00:00:60Z', '10:60:00Z',
    '10:00:00+24:00', '10:00:00+02', '10:00:00+0200', '10:00:00+02:00', '10:00:00+2', '10:00:00+02:0', '10:00:00+23:59', '10:00:00+99:99', '10:00:00+02:60', '10:00:00-0260', '10:00:00-00:60', '10:00:00+2400',
    '10:00:00.123456789Z', '10:00:00.5', '10:00:00.Z', '10:00Z', '10:00:00 Z', '1:00:00Z', '10:00:00Zz', '',
  ],
  'date-time': [
    '2026-11-11T10:00:00Z', '2026-11-11t10:00:00z', '2026-11-11 10:00:00Z', '2026-11-11T10:00:00', '2026-11-11T10:00:00.5', '2026-11-11T10:00:00+02:00', '2026-11-11T10:00:00+0200', '2026-11-11T10:00:00+02',
    '2026-11-11T10:00:60Z', '2026-11-11T23:59:60Z', '2026-11-11T24:00:00Z', '2026-02-29T10:00:00Z', '2026-02-30T10:00:00Z', '2026-11-11', '2026-11-11T', 'T10:00:00Z', '2026-11-11T10:00:00Z ', '2026-11-11  10:00:00Z',
    '2026-11-11T10:00:00.Z', '2026-11-11Tt10:00:00Z', '2026-11-11T10:00:00Zt', '2026-11-11 10:00:00 Z', '2026-11-11\t10:00:00Z', '2026-11-11\n10:00:00Z', '2026-11-11\u00a010:00:00Z', '2026-11-11T10:00:00T', '',
  ],
  email: [
    'ada@example.com', 'a@b', 'a@b.c', 'a.@b.c', '.a@b.c', 'a..b@c.d', 'a@-b.c', 'a@b-.c', 'a@b.c.', 'a b@c.d', '"a"@b.c', 'a@[1.2.3.4]', 'a@b_c.d', 'ü@b.c', 'a+b@c.d', 'a@localhost', 'a@b@c.d', '@b.c', 'a@', 'A@B.C', 'a@b.c-d', 'a@1.2',
    `${x(65)}@b.c`, `a@${x(64)}.com`, `a@${`${x(60)}.`.repeat(5)}com`, "a!#$%&'*+/=?^_`{|}~-@b.c", 'a@b..c', 'a@.b.c', '',
  ],
  uri: [
    'https://vercel.com/x?y=1', 'https://x.com/<a>', 'a:b', 'http://x.com/a b', 'mailto:ada@example.com', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', 'https://x.com/%zz', 'https://x.com/a%20b', 'https://[::1]/', 'https://[::1', 'HTTP://X.COM',
    'x:', 'a:', 'a://', 'https://', '1a:b', 'https://x.com/"q"', 'https://x.com/{a}', 'https://x.com/a\\b', 'https://x.com/a^b', 'https://x.com/`', 'https://x.com/|', 'ftp://user:pw@host:21/x', 'https://x.com#frag', 'https://x.com?#',
    'https://x.com/a#b#c', '#frag', '//x.com', 'https://x.com/ü', 'https://x.com:port/', 'https://x.com:8080/', 'https://x.com/[a]', 'file:///etc/hosts', 'a+b.c-d:e', 'https://exa_mple.com', 'vercel.com', 'a:/', 'a:?', 'a:#', 'https://256.1.1.1/', 'https://1.2.3.4:/', '',
  ],
  uuid: ['123e4567-e89b-12d3-a456-426614174000', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000', 'URN:UUID:123e4567-e89b-12d3-a456-426614174000', '123e4567e89b12d3a456426614174000', '{123e4567-e89b-12d3-a456-426614174000}', '123e4567', '123e4567-e89b-12d3-a456-42661417400g', '123e4567-e89b-12d3-a456-4266141740000', '00000000-0000-0000-0000-000000000000', ''],
  hostname: [
    'api.vercel.com', 'a', 'a.', 'a..b', '-a', 'a-', 'a-b', 'a_b', 'A.B', x(63), x(64), `${x(63)}.${x(63)}.${x(63)}.${x(61)}`, `${x(63)}.${x(63)}.${x(63)}.${x(62)}`, `${x(63)}.${x(63)}.${x(63)}.${x(61)}.`, `${x(63)}.${x(63)}.${x(63)}.${x(62)}.`,
    '1.2.3.4', '', '.', 'a.b.', 'a.b..', 'a b', 'ü.com', 'xn--bcher-kva.com', '-api.vercel.com', 'api-.vercel.com',
  ],
  ipv4: ['1.2.3.4', '10.0.0.255', '10.0.0.256', '01.2.3.4', '1.2.3.04', '10.0.0.01', '00.0.0.0', '000.0.0.0', '0000.0.0.0', '1.2.3.004', '09.1.1.1', '199.1.1.1', '299.1.1.1', '1.2.3', '1.2.3.4.5', '0.0.0.0', '255.255.255.255', '1.2.3.4 ', '1.2.3.-4', '1.2.3.', '.1.2.3', '1..2.3', '1.2.3.4\n', '1.2.3.1e1', '١.2.3.4', ''],
  ipv6: [
    '::', '::1', '1::', '2001:db8::1', '2001:db8::1::', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.4', '1::2::3', 'fe80::1%eth0', '12345::', 'g::1', '::1.2.3.256', '1:2:3:4:5:6:1.2.3.4', '::01.2.3.4', '::1.2.3.04', ':1', '1:',
    '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '1:2:3:4:5:6:7:1.2.3.4', '1:2:3:4:5::1.2.3.4', 'ABCD::abcd', '::1.2.3.4', '1.2.3.4', '1::2:3:4:5:6:7:8', '1::2:3:4:5:6:7', '::1.2.3', ':::', '1:::2', '1:2:3:4::5:1.2.3.4', '1:2:3:4:5:6::1.2.3.4', '',
  ],
}

// A small generator, the same every run: definitions the registry's keywords make, and values for them.
function generator(start: number) {
  let seed = start
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const int = (below: number) => Math.floor(random() * below)
  const pick = <T,>(list: readonly T[]): T => list[int(list.length)]!
  const NAMES = ['a', 'b', 'c', 'id', 'n']
  const STRINGS = ['', 'a', 'ab', 'started', 'stopped', x(5), '😀', 'é😀a', '2026-11-11', '10:00:00Z', '1.2.3.4', 'a@b.c', 'https://x.com']
  const NUMBERS = [0, 1, -1, 2, 3, 1.5, 2.5, 10, 0.1, 100]
  function value(depth = 0): unknown {
    const kind = int(depth > 2 ? 5 : 7)
    if (kind === 0) return null
    if (kind === 1) return random() < 0.5
    if (kind === 2) return pick(NUMBERS)
    if (kind === 3 || kind === 4) return pick(STRINGS)
    if (kind === 5) return Array.from({ length: int(4) }, () => value(depth + 1))
    return Object.fromEntries(Array.from({ length: int(4) }, () => [pick(NAMES), value(depth + 1)]))
  }
  /** A definition the reference's strict mode takes more often than not: a keyword for one type comes with that type, and `required` names declared properties. */
  function schema(depth = 0): Record<string, unknown> | boolean {
    if (depth > 0 && random() < 0.04) return random() < 0.7
    const out: Record<string, unknown> = {}
    // A definition describes an object: so does the one at the top.
    const type = depth === 0 ? 'object' : pick(['object', 'array', 'string', 'string', 'number', 'integer', 'integer', 'boolean', 'null', undefined, ['string', 'null'], ['integer', 'null'], ['object', 'array']] as const)
    if (type !== undefined) out.type = type
    const is = (name: string) => type === name || (Array.isArray(type) && (type as readonly string[]).includes(name))
    const sub = () => schema(depth + 1)
    const deep = depth < 3
    if (is('object')) {
      const names = deep && (depth === 0 || random() < 0.7) ? [...new Set(Array.from({ length: int(3) + 1 }, () => pick(NAMES)))] : []
      if (names.length > 0) out.properties = Object.fromEntries(names.map((name) => [name, sub()]))
      const required = names.filter(() => random() < 0.5)
      if (required.length > 0) out.required = required
      if (random() < 0.3) out.additionalProperties = deep && random() < 0.5 ? sub() : random() < 0.5
    }
    if (is('array')) {
      // One schema for every item, or a list of them, one for each place: the reference takes a list only with both bounds at its length.
      if (deep && random() < 0.3) {
        const list = Array.from({ length: int(3) + 1 }, sub)
        Object.assign(out, { items: list, minItems: list.length, maxItems: list.length })
      } else {
        if (deep && random() < 0.5) out.items = sub()
        if (random() < 0.3) out.minItems = int(3)
        if (random() < 0.3) out.maxItems = int(4)
      }
    }
    if (is('string')) {
      if (random() < 0.3) out.minLength = int(3)
      if (random() < 0.3) out.maxLength = int(6)
      if (random() < 0.3) out.format = pick(SCHEMA_FORMATS)
    }
    if (is('number') || is('integer')) {
      if (random() < 0.3) out.minimum = pick(NUMBERS)
      if (random() < 0.3) out.maximum = pick(NUMBERS)
      if (random() < 0.2) out.exclusiveMinimum = pick(NUMBERS)
      if (random() < 0.2) out.exclusiveMaximum = pick(NUMBERS)
      if (random() < 0.2) out.multipleOf = pick([1, 2, 0.5, 3, 0.1])
    }
    if (random() < 0.15) out.enum = Array.from({ length: int(3) + 1 }, () => value(2))
    if (random() < 0.1) out.const = value(2)
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) if (deep && random() < 0.12) out[keyword] = Array.from({ length: int(3) + 1 }, sub)
    if (deep && random() < 0.08) out.not = sub()
    return out
  }
  /**
   * A value shaped by `definition`: right more often than not, and wrong at each keyword's edge (a
   * number beside its bound, a string one character short, an item out of place), so that every
   * keyword decides answers. A free value is what the top-level type alone refuses.
   */
  function valueFor(definition: unknown, depth = 0): unknown {
    if (typeof definition !== 'object' || definition === null || random() < 0.08) return value(depth)
    const rule = definition as Record<string, unknown>
    if ('const' in rule && random() < 0.6) return rule.const
    if (Array.isArray(rule.enum) && random() < 0.6) return pick(rule.enum)
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(rule[keyword]) && random() < 0.3) return valueFor(pick(rule[keyword] as unknown[]), depth)
    const numbers = (...names: string[]) => names.map((name) => rule[name]).filter((bound): bound is number => typeof bound === 'number')
    const type = pick(rule.type === undefined ? ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] : Array.isArray(rule.type) ? (rule.type as string[]) : [rule.type as string])
    if (type === 'null') return null
    if (type === 'boolean') return random() < 0.5
    if (type === 'number' || type === 'integer') {
      const bounds = numbers('minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum')
      const near = bounds.length > 0 ? pick(bounds) + pick([-1, 0, 0, 1, 0.5]) : pick(NUMBERS)
      const stepped = typeof rule.multipleOf === 'number' && random() < 0.6 ? Math.round(near / rule.multipleOf) * rule.multipleOf : near
      return type === 'integer' && random() < 0.8 ? Math.round(stepped) : stepped
    }
    if (type === 'string') {
      if (typeof rule.format === 'string' && random() < 0.7) return pick(SAMPLES[rule.format as keyof typeof SAMPLES])
      const lengths = numbers('minLength', 'maxLength')
      const length = lengths.length > 0 ? Math.max(0, pick(lengths) + pick([-1, 0, 0, 1])) : int(7)
      // Astral characters count once each, however many code units they take.
      return (random() < 0.2 ? '😀' : 'x').repeat(length)
    }
    if (type === 'array') {
      if (Array.isArray(rule.items)) {
        const list = rule.items.map((item) => valueFor(item, depth + 1))
        // Short by one, or its first two out of place, now and then.
        const slip = random()
        return slip < 0.15 ? list.slice(1) : slip < 0.3 && list.length > 1 ? [list[1], list[0], ...list.slice(2)] : list
      }
      const counts = numbers('minItems', 'maxItems')
      const length = counts.length > 0 ? Math.max(0, pick(counts) + pick([-1, 0, 0, 1])) : int(4)
      return Array.from({ length }, () => (rule.items === undefined ? value(depth + 1) : valueFor(rule.items, depth + 1)))
    }
    const made: Record<string, unknown> = {}
    for (const [name, property] of Object.entries((rule.properties ?? {}) as Record<string, unknown>)) if (random() < 0.85) made[name] = valueFor(property, depth + 1)
    if (random() < 0.25) made[pick(NAMES)] = typeof rule.additionalProperties === 'object' ? valueFor(rule.additionalProperties, depth + 1) : value(depth + 1)
    return made
  }
  return { schema, value, valueFor }
}

describe('a value, as Vercel\'s API would take it', () => {
  it('gets the same answer for every format, at what it ordinarily holds and at its edges', () => {
    const disagree: string[] = []
    for (const format of SCHEMA_FORMATS) {
      const schema = { type: 'object', properties: { v: { type: 'string', format } } }
      const takes = reference(schema)!
      for (const sample of SAMPLES[format]) {
        const ours = checkValue(schema, { v: sample }) === null
        if (ours !== takes({ v: sample })) disagree.push(`${format} ${JSON.stringify(sample)}: board ${ours ? 'takes' : 'refuses'} it`)
      }
    }
    expect(disagree).toEqual([])
    // The reference is listening: it has these formats, and parts them where the API does.
    const takes = (format: string, sample: string) => reference({ type: 'object', properties: { v: { type: 'string', format } } })!({ v: sample })
    expect([takes('ipv4', '10.0.0.01'), takes('uri', 'https://x.com/<a>'), takes('time', '10:00:60Z'), takes('time', '10:00:00+99:99'), takes('date-time', '2026-11-11\t10:00:00Z')]).toEqual([true, false, false, true, true])
  })

  it('checks each item of a list by its place when a schema gives a list of them', () => {
    const schema = { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], minItems: 2, maxItems: 2 } } }
    const takes = reference(schema)!
    const values = [{ pair: ['cpu', 4] }, { pair: [4, 'cpu'] }, { pair: ['cpu', 'four'] }, { pair: ['cpu'] }, { pair: ['cpu', 4, true] }, { pair: [] }, {}]
    expect(values.map((value) => checkValue(schema, value) === null)).toEqual(values.map(takes))
    expect(checkValue(schema, { pair: [4, 'cpu'] })).toBe('pair[0] must be a string')
    expect(checkValue(schema, { pair: ['cpu', 4] })).toBeNull()
    // What would say more of the items past a list, `additionalItems`, no registry takes: not a board's, and not Vercel's, whose keywords are a board's.
    expect(checkDefinition({ type: 'object', properties: { pair: { type: 'array', items: { type: 'string' }, additionalItems: false } } })).toMatch(/additionalItems/)
  })

  it('gets the same answer across generated definitions, for values shaped by each', () => {
    const { schema, valueFor } = generator(7)
    const disagree: unknown[] = []
    let taken = 0
    let refusedInside = 0
    for (let round = 0; round < 900; round++) {
      const definition = schema() as Record<string, unknown>
      const takes = reference(definition)
      // What the reference won't compile, the API registers none of.
      if (!takes) continue
      for (let each = 0; each < 16; each++) {
        const candidate = valueFor(definition)
        const answer = takes(candidate)
        if ((checkValue(definition, candidate) === null) !== answer) disagree.push({ definition, candidate })
        if (answer) taken++
        // An object the reference refuses is refused by a keyword inside, not by the type at the top.
        else if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) refusedInside++
      }
    }
    expect(disagree.slice(0, 3)).toEqual([])
    // Enough answers each way to mean something: values the keywords take, and values they refuse.
    expect({ taken: taken > 1000, refusedInside: refusedInside > 300 }).toEqual({ taken: true, refusedInside: true })
  }, 60_000)
})
