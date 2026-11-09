import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileAccess, FULL_ACCESS, InvalidCan } from '../src/access/index.ts'
import { caller, personToken, testBoard } from './harness.ts'

// What `@vercel/board/access` gives a backend that decides access itself, as Vercel's API does.

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

describe('@vercel/board/access', () => {
  it('throws an InvalidCan, code invalid_can, for a can that does not parse', () => {
    for (const can of [{ 'feedback/*': ['post'] }, ['write'], { 'Not A Channel': ['read'] }] as never[]) {
      let thrown: unknown
      try {
        compileAccess(can)
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(can)).toBeInstanceOf(InvalidCan)
      expect((thrown as InvalidCan).code).toBe('invalid_can')
    }
  })

  it('remembers a bounded number of channels, however many a long-lived access is asked about', () => {
    for (const [name, access] of [
      ['everything', FULL_ACCESS],
      ['nothing', compileAccess([])],
      ['a pattern', compileAccess({ '*': ['read'], 'secret/': [] })],
    ] as const) {
      gc()
      const before = process.memoryUsage().heapUsed
      for (let i = 0; i < 200_000; i++) access.readable(`team/channel-${i}`)
      gc()
      expect(process.memoryUsage().heapUsed - before, name).toBeLessThan(4 * 1024 * 1024)
    }
  })

  it('answers what it may read the same once it has started over', () => {
    const access = compileAccess({ '*': ['read'], 'secret/': [] })
    for (let i = 0; i < 10_000; i++) expect(access.readable(i % 2 ? `secret/${i}` : `team/${i}`)).toBe(i % 2 === 0)
    expect([access.readable('secret'), access.readable('team'), FULL_ACCESS.readable('secret'), compileAccess([]).readable('team')]).toEqual([false, true, true, false])
  })
})

describe('parseCan, from @vercel/board/access', () => {
  it("parses and refuses an x-board-can header exactly as the board does, from the package an app installs", async () => {
    // Resolved as an app resolves it, through the package's exports, to what the build put there.
    const require = createRequire(import.meta.url)
    expect(require.resolve('@vercel/board/access')).toMatch(/dist\/access\.mjs$/)
    const access = (await import(pathToFileURL(require.resolve('@vercel/board/access')).href)) as typeof import('../src/access/index.ts')
    const { fetch } = testBoard()
    const token = await personToken()
    const headers = [
      'dev/=read,post;ci/=read',
      ' dev/ = read , post ; ',
      '*=all',
      'dev/=',
      `dev/=all${';'.repeat(access.CAN_MAX - 'dev/=all'.length)}`,
      `dev/=all${';'.repeat(access.CAN_MAX - 'dev/=all'.length + 1)}`,
      '',
      ';',
      'dev/',
      'dev/=fly',
      'dev/=read;dev/=post',
      'feedback/*=post',
      'Not A Channel=read',
    ]
    const answers = []
    for (const header of headers) {
      let parsed: ReturnType<typeof access.parseCan> | InvalidCan
      try {
        parsed = access.parseCan(header)
      } catch (error) {
        // The error a caller branches on is the one the entry exports.
        expect(error).toBeInstanceOf(access.InvalidCan)
        parsed = error as InvalidCan
      }
      const me = await caller(fetch, token, { 'x-board-can': header })('GET', '/me')
      answers.push([header.length > 40 ? `${header.length} characters` : header, parsed instanceof Error ? 'refused' : 'parsed'])
      if (parsed instanceof Error) expect(me, header).toMatchObject({ status: 400, body: { error: { code: 'invalid_scope', message: parsed.message } } })
      else expect([header, me.status, me.body.can], header).toEqual([header, 200, access.compileAccess(parsed).summary()])
    }
    // Both kinds, so neither half of the comparison goes unchecked.
    expect(answers).toEqual([
      ['dev/=read,post;ci/=read', 'parsed'],
      [' dev/ = read , post ; ', 'parsed'],
      ['*=all', 'parsed'],
      ['dev/=', 'parsed'],
      [`${access.CAN_MAX} characters`, 'parsed'],
      [`${access.CAN_MAX + 1} characters`, 'refused'],
      ['', 'refused'],
      [';', 'refused'],
      ['dev/', 'refused'],
      ['dev/=fly', 'refused'],
      ['dev/=read;dev/=post', 'refused'],
      ['feedback/*=post', 'refused'],
      ['Not A Channel=read', 'refused'],
    ])
  })
})
