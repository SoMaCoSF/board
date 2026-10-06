import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardUpdate, repoName, workOf, workRootId } from '../src/cli/hooks.ts'

describe('hooks', () => {
  it('finds the board update an agent ends its reply with', () => {
    expect(boardUpdate('Done.\n\nBoard update: Added label sync; reconcile next.')).toBe('Added label sync; reconcile next.')
    expect(boardUpdate('Done.\n**Board update:** Fixed the flaky test.')).toBe('Fixed the flaky test.')
    expect(boardUpdate('> board update: shipped #18\n')).toBe('shipped #18')
    expect(boardUpdate('Board update: first\nmore\n\nBoard update: the last one wins')).toBe('the last one wins')
    expect(boardUpdate('Board update: skip')).toBe('skip')
    expect(boardUpdate('**Board update:** Skip.')).toBe('skip')
    // Only at the start of a line, and only with something after it.
    expect(boardUpdate('I will post a board update: later.')).toBeNull()
    expect(boardUpdate('Board update:')).toBeNull()
    expect(boardUpdate('All done.')).toBeNull()
    // Only the reply's last line: nothing after it, and no quoted syntax, leaves the machine.
    expect(boardUpdate('Board update: Fixed X.\n\nLet me know if you want more.')).toBeNull()
    expect(boardUpdate('It works like this:\n\nBoard update: <summary>\n\nThen the hook posts it.')).toBeNull()
    expect(boardUpdate('Board update: <summary>')).toBeNull()
    expect(boardUpdate(`Board update: ${'x'.repeat(2000)}`)).toHaveLength(1500)
  })

  it('names the repo from its origin remote', () => {
    expect(repoName('git@github.com:basehub-ai/vboard.git')).toBe('basehub-ai/vboard')
    expect(repoName('https://github.com/basehub-ai/vboard')).toBe('basehub-ai/vboard')
    expect(repoName('https://gitlab.com/acme/app.git/')).toBe('acme/app')
    expect(repoName('')).toBeNull()
  })

  it('keys work by repo and branch, escaping the | that label filters split on', () => {
    const repo = mkdtempSync(join(tmpdir(), 'vboard-work-'))
    execFileSync('git', ['init', '-q', '-b', 'fix|pipes'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: repo })
    expect(workOf(repo)).toEqual({ repo: 'acme/app', branch: 'fix|pipes', key: 'acme/app@fix%7Cpipes' })
  })

  it("keeps the work root's ID within the limit, however long the branch", () => {
    expect(workRootId('u_julian', `acme/app@${'b'.repeat(250)}`)).toHaveLength(37)
    expect(workRootId('u_julian', 'acme/app@main')).not.toBe(workRootId('u_ada', 'acme/app@main'))
  })
})
