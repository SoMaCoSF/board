import { describe, expect, it } from 'vitest'
import type { Actor, ActorsState } from '../src/contract/reducers.ts'
import { addressAgents, displayMentions, exactMentions, extractMentions } from '../src/contract/mentions.ts'
import { resolveHandle, resolveMentions } from '../src/server/actors.ts'

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

describe('addressing agents', () => {
  const declared = (name: string) => ['helper', 'pi'].includes(name)
  const app = ['@vboard-factory[bot]', '@vboard-factory']

  it('turns `@<app> +name` into the agent, for each name the board declares', () => {
    expect(addressAgents('@vboard-factory +helper look', app, declared)).toBe('@[vboard:agent:helper] look')
    expect(addressAgents('@vboard-factory[bot] +helper +pi both?', app, declared)).toBe('@[vboard:agent:helper] @[vboard:agent:pi] both?')
    expect(addressAgents('hey @VBOARD-FACTORY +Helper', app, declared)).toBe('hey @[vboard:agent:helper]')
  })

  it('leaves the rest as written: unknown names, a bare +name, and code', () => {
    expect(addressAgents('@vboard-factory +nobody hi', app, declared)).toBe('@vboard-factory +nobody hi')
    expect(addressAgents('ask +helper later', app, declared)).toBe('ask +helper later')
    expect(addressAgents('run `@vboard-factory +helper`', app, declared)).toBe('run `@vboard-factory +helper`')
    expect(addressAgents('@vboard-factory +helper', [], declared)).toBe('@vboard-factory +helper')
  })
})

describe('exact and display forms', () => {
  it('swap what a platform marked for its actor, longest form first', () => {
    const marked = [
      { form: '@Ada', actor: 'slack:user:U1' },
      { form: '@Ada Lovelace', actor: 'slack:user:U2' },
    ]
    expect(exactMentions('@Ada Lovelace and @ada, `@Ada`', marked)).toBe('@[slack:user:U2] and @[slack:user:U1], `@Ada`')
  })

  it('tell apart two people who show the same name by where each appears, or leave both as text', () => {
    const ada = (n: number) => ({ form: '@Ada', actor: `slack:user:U${n}` })
    expect(exactMentions('@Ada, then @Ada, then @Ada again', [ada(1), ada(2), ada(1)])).toBe(
      '@[slack:user:U1], then @[slack:user:U2], then @[slack:user:U1] again',
    )
    expect(exactMentions('@Ada and @Ada', [ada(1), ada(2), ada(1)])).toBe('@Ada and @Ada')
    expect(exactMentions('@Ada and @Ada', [ada(1), ada(1)])).toBe('@[slack:user:U1] and @[slack:user:U1]')
  })

  it('show exact mentions by handle, and leave unknown ones as they are', () => {
    expect(displayMentions('@[vboard:agent:helper] meet @[slack:user:U9]', { 'vboard:agent:helper': { handle: 'helper' } })).toBe(
      '@helper meet @[slack:user:U9]',
    )
  })
})

describe('resolving a typed @handle', () => {
  const actor = (id: string, kind: Actor['kind'], handle = 'sam'): Actor => ({ id, kind, handle, name: id, avatar: null })
  const state = (actors: Actor[], links: ActorsState['links'] = {}): ActorsState => {
    const byHandle: Record<string, string[]> = {}
    for (const a of actors) (byHandle[a.handle] ??= []).push(a.id)
    return { byId: Object.fromEntries(actors.map((a) => [a.id, a])), byHandle, links }
  }
  const link = (to: string) => ({ to, method: 'code' as const, at: '2026-10-14T00:00:00Z' })

  it('goes in a fixed order, so a shared handle still names one actor', () => {
    const agent = actor('vboard:agent:sam', 'agent')
    const person = actor('vercel:user:u_sam', 'person')
    const profile = actor('vercel:user:u_jo+sam', 'agent')
    const deployment = actor('vercel:deployment:prj_sam', 'deployment')
    const slack = actor('slack:user:U_SAM', 'external')
    const watcher = actor('vboard:watch:sam', 'deployment')
    const order = [agent, person, profile, deployment, slack]
    for (let n = 0; n < order.length; n++)
      expect(resolveHandle('sam', { known: state([watcher, ...order.slice(n)]) })).toBe(order[n]!.id)
    // Nobody it can name: it stays plain text.
    expect(resolveHandle('sam', { known: state([watcher]) })).toBeNull()
  })

  it('counts platform accounts linked to one person as that person, and prefers who is in the thread', () => {
    const person = actor('vercel:user:u_sam', 'person', 'samuel')
    const slack = actor('slack:user:U_SAM', 'external')
    const github = actor('github:user:7', 'external')
    expect(resolveHandle('sam', { known: state([person, slack, github], { [slack.id]: link(person.id), [github.id]: link(person.id) }) })).toBe(person.id)

    const other = actor('slack:user:U_OTHER', 'external')
    const known = state([slack, other])
    expect(() => resolveHandle('sam', { known })).toThrow('ambiguous mention @sam')
    expect(resolveHandle('sam', { known, participants: new Set([other.id]) })).toBe(other.id)
    expect(resolveHandle('sam', { known, lenient: true })).toBeNull()
  })

  it('stores what it resolved by ID, and, for platform text, only within the platform', () => {
    const slack = actor('slack:user:U_SAM', 'external')
    const github = actor('github:user:7', 'external', 'samgh')
    const known = state([slack, github])
    expect(resolveMentions('cc @sam and @samgh', { known })).toEqual({ text: 'cc @[slack:user:U_SAM] and @[github:user:7]', mentions: [slack.id, github.id], unknown: [] })
    expect(resolveMentions('cc @sam and @samgh', { known, lenient: true, scope: 'github:user:' })).toEqual({ text: 'cc @sam and @[github:user:7]', mentions: [github.id], unknown: [] })
    expect(resolveMentions('cc @sam', { known, lenient: true, scope: null })).toEqual({ text: 'cc @sam', mentions: [], unknown: [] })
  })
})
