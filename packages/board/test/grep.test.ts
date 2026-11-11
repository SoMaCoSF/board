import { describe, expect, it } from 'vitest'
import { grepChannel } from '../src/cli/grep.ts'

const a = (text: string) => text === 'a'

describe('vb grep over one channel', () => {
  it('prints each match once, with its neighbours, and a group for each run whose context touches', () => {
    const channel = ['a', 'x', 'x', 'a', 'x', 'x', 'x', 'a']
    expect(grepChannel(channel, a, { max: Infinity, before: 0, after: 0 })).toEqual({ hits: [0, 3, 7], groups: [[0], [3], [7]] })
    expect(grepChannel(channel, a, { max: Infinity, before: 1, after: 1 }).groups).toEqual([[0, 1, 2, 3, 4], [6, 7]])
    expect(grepChannel(channel, a, { max: Infinity, before: 0, after: 3 }).groups).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]])
    expect(grepChannel(channel, a, { max: 2, before: 2, after: 0 })).toEqual({ hits: [0, 3], groups: [[0, 1, 2, 3]] })
    expect(grepChannel(channel, a, { max: 0, before: 0, after: 0 })).toEqual({ hits: [], groups: [] })
  })

  // Past about 150,000 matches, spreading them into one call overflows the stack, and checking
  // each message against every match takes minutes.
  it('greps a channel where 300,000 messages match, with and without context', () => {
    const channel = Array.from({ length: 300_000 }, (_, at) => (at % 3 ? 'a' : 'x'))
    expect(grepChannel(channel, a, { max: Infinity, before: 0, after: 0 }).hits).toHaveLength(200_000)
    const { groups } = grepChannel(channel, a, { max: Infinity, before: 1, after: 1 })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(300_000)
  })
})
