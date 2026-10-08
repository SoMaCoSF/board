import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexNetwork, reminder, repoName, workOf } from '../src/cli/hooks.ts'

describe('hooks', () => {
  it('reminds with the exact commands, and keeps going quiet possible', () => {
    const text = reminder('vb', 'work')
    expect(text).toContain('vb update "<summary>"')
    expect(text).toContain('vb reply <id> "<text>"')
    expect(text).toContain('vb update --skip')
    expect(reminder('vb', 'eng/work')).toContain('vb update --channel eng/work "<summary>"')
  })

  it('suggests a Codex profile that allows only the board and Vercel', () => {
    const { top, tables } = codexNetwork('board.example.com')
    expect(top).toBe('default_permissions = "vboard"') // a top-level key: it can't follow a [table]
    expect(tables).not.toContain('default_permissions')
    expect(tables).toContain('"board.example.com" = "allow"\n"api.vercel.com" = "allow"')
    expect(codexNetwork(null).tables).toContain('"<your board host>" = "allow"\n"api.vercel.com" = "allow"')
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
})
