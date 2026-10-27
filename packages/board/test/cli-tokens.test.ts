import { describe, expect, it } from 'vitest'
import { useBoard, vb } from './cli-harness.ts'

useBoard()

describe('vb token', () => {
  it('mints a token that vb writes with, as the profile and session it signed, inside an agent session too', async () => {
    const minted = await vb(['token', '--scope', 'dev/*', '--permission', 'read,post', '--as', 'lemur', '--session', 'thread-7', '--json'])
    expect(minted).toMatchObject({ code: 0, stderr: '' })
    const { token, can } = JSON.parse(minted.stdout)
    expect(can).toEqual({ 'dev/': ['read', 'post'] })

    // Inside Claude Code, vb would name its profile and session: a delegate's token names them instead.
    const agent = { BOARD_TOKEN: token, BOARD_HANDLE: undefined, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc' }
    const posted = await vb(['post', 'dev/agents', 'on it', '--json'], agent)
    expect(posted).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(posted.stdout).by).toMatchObject({ principal: 'vercel:user:u_julian', profile: 'lemur', session: 'thread-7' })

    const outside = await vb(['post', 'ops', 'not mine'], agent)
    expect(outside).toMatchObject({ code: 1, stderr: "error: this token can't post in ops\n" })
    expect(await vb(['token'], agent)).toMatchObject({ code: 1, stderr: "error: this is a delegate token, so it can't mint another token\n" })
  }, 30_000)

  it('takes a whole scope, and refuses a pattern without permissions', async () => {
    const minted = await vb(['token', '--scope', 'feedback/=post;dev=read', '--json'])
    expect(JSON.parse(minted.stdout).can).toEqual({ dev: ['read'], 'feedback/': ['post'] })
    expect(await vb(['token', '--scope', 'feedback/'])).toMatchObject({ code: 2 })
  }, 30_000)
})
