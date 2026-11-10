import { describe, expect, it } from 'vitest'
import { extractMentions } from '../src/contract/mentions.ts'
import { importedHandle, typableHandle } from '../src/contract/profiles.ts'
import type { ActorsState, Message } from '../src/contract/folds.ts'
import { compileFilter } from '../src/server/feed.ts'
import { FULL_ACCESS } from '../src/server/access.ts'

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

describe('a mentions filter', () => {
  const nobody: ActorsState = { byId: {}, byHandle: {} }
  const message = (text: string) => ({ id: 1, channel: 'dev', text, re: null }) as Message

  it('takes names every object has as names nobody has', () => {
    const matcher = (name: string) => compileFilter({ mentions: name }, { me: null, actors: nobody, access: FULL_ACCESS })
    for (const name of ['constructor', 'toString', 'valueOf']) {
      const matches = matcher(name)
      expect([matches(message(`thanks @${name}`)), matches(message(`cc @[${name}]`)), matches(message('thanks @someone'))], name).toEqual([true, true, false])
    }
    expect([matcher('__proto__')(message('cc @[__proto__]')), matcher('__proto__')(message('cc @[someone]'))]).toEqual([true, false])
  })
})

describe("an imported platform user's handle", () => {
  it('is typable as a mention, and made so in one pass, however long a run of punctuation it holds', () => {
    expect(typableHandle('Malte Ubl', 'user:U_MALTE')).toBe('malte-ubl')
    // Diacritics come off first, so what's left reads as the name.
    expect(typableHandle('Jürgen', 'user:U_J')).toBe('jurgen')
    expect(typableHandle('--.Ünïcode_ ', 'user:U_X')).toBe('unicode')
    // With nothing left, their ID on the platform, the same way.
    expect(typableHandle('🙂', 'T_EU:U0MALTE')).toBe('t_eu-u0malte')
    // A run a trim by regex would backtrack over from every dash in it.
    const long = `x${'-'.repeat(200_000)}x`
    const started = performance.now()
    expect(typableHandle(long, 'user:U_X')).toBe(long)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("fits the 128 characters a handle holds under its principal's name, cut on whole characters with the ends trimmed again", () => {
    expect(importedHandle('support', 'a'.repeat(125), 'user:U1')).toBe(`support/${'a'.repeat(120)}`)
    // A cut that ends on a separator trims it off, as the rule does.
    expect(importedHandle('support', `${'a'.repeat(119)}--b`, 'user:U1')).toBe(`support/${'a'.repeat(119)}`)
    expect(importedHandle('support', 'Malte Ubl', 'user:U1')).toBe('support/malte-ubl')
  })
})
