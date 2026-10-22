import { describe, expect, it } from 'vitest'
import { extractMentions } from '../src/contract/mentions.ts'
import type { ActorsState } from '../src/contract/reducers.ts'
import { resolveMentions } from '../src/server/actors.ts'

describe('extractMentions', () => {
  it('finds handles and profile handles in prose, in order', () => {
    expect(extractMentions('hey @Ada and @julian/claude, see @ada')).toEqual([
      { kind: 'handle', handle: 'ada' },
      { kind: 'handle', handle: 'julian/claude' },
    ])
  })

  it('ignores mentions inside code', () => {
    expect(extractMentions('run `@ada` and\n```\n@bob\n```\nthen @carol')).toEqual([
      { kind: 'handle', handle: 'carol' },
    ])
  })

  it('ignores emails and trailing punctuation', () => {
    expect(extractMentions('mail ada@example.com, ping @bob.')).toEqual([
      { kind: 'handle', handle: 'bob' },
    ])
  })

  it('reads exact actor mentions', () => {
    expect(extractMentions('cc @[slack:T0123:U0456] and @ada')).toEqual([
      { kind: 'actor', actor: 'slack:T0123:U0456' },
      { kind: 'handle', handle: 'ada' },
    ])
  })
})

describe('resolveMentions', () => {
  const nobody: ActorsState = { byId: {}, byHandle: {}, links: {} }

  it('takes names every object has as names nobody has', () => {
    expect(resolveMentions('thanks @constructor', nobody)).toEqual({ mentions: [], unknown: ['constructor'] })
    for (const actor of ['constructor', 'toString', '__proto__'])
      expect(() => resolveMentions(`cc @[${actor}]`, nobody)).toThrow(`unknown actor @[${actor}]`)
    // Platform text never fails a write: an import with them goes through.
    expect(resolveMentions('@constructor @[constructor] @[__proto__]', nobody, undefined, true)).toEqual({ mentions: [], unknown: [] })
  })
})
