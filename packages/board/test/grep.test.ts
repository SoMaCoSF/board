import { describe, expect, it } from 'vitest'
import { grep } from '../src/cli/grep.ts'

const channel = (texts: string[]) => texts.map((text, at) => ({ id: String(at), text }))
const all = { max: Infinity, before: 0, after: 0, ref: (id: string) => id }

describe('vb grep over messages already read', () => {
  it('prints a row a match, its neighbours as context, and -- between groups and channels', () => {
    const channels = new Map([['ci', channel(['a', 'x', 'x', 'a', 'x', 'x', 'x', 'a'])], ['web', channel(['a'])]])
    expect(grep(channels, /a/, all).rows).toEqual(['ci:0:a', 'ci:3:a', 'ci:7:a', 'web:0:a'])
    expect(grep(channels, /a/, { ...all, before: 1, after: 1 }).rows).toEqual(['ci:0:a', 'ci-1-x', 'ci-2-x', 'ci:3:a', 'ci-4-x', '--', 'ci-6-x', 'ci:7:a', '--', 'web:0:a'])
    expect(grep(channels, /a/, { ...all, max: 2, before: 2 }).rows).toEqual(['ci:0:a', 'ci-1-x', 'ci-2-x', 'ci:3:a'])
    expect(grep(channels, /a/, { ...all, only: 'count' }).rows).toEqual(['ci:3', 'web:1'])
    expect(grep(channels, /x/, { ...all, only: 'channels' }).rows).toEqual(['ci'])
  })

  // Past about 150,000 matches, spreading them into one call overflows the stack, and checking
  // each message against every match takes minutes.
  it('greps a channel where 200,000 of 300,000 messages match, with and without context', () => {
    const channels = new Map([['ci', channel(Array.from({ length: 300_000 }, (_, at) => (at % 3 ? 'a' : 'x')))]])
    expect(grep(channels, /a/, all).matches).toHaveLength(200_000)
    expect(grep(channels, /a/, { ...all, only: 'count' }).rows).toEqual(['ci:200000'])
    expect(grep(channels, /a/, { ...all, before: 1, after: 1 }).rows).toHaveLength(300_000)
  })
})
