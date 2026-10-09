import { execFileSync, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CLI, env, tmp, url, useBoard, vb, vb_in } from './cli-harness.ts'

useBoard()

describe('cli hooks', () => {
  it('installs turn-end hooks, and the permissions their reminder needs, keeping what else is there', async () => {
    const home = await tmp('vboard-home-')
    const at = { HOME: home, CODEX_HOME: join(home, '.codex') }
    await mkdir(join(home, '.claude'), { recursive: true })
    const settings = join(home, '.claude', 'settings.json')
    const theirs = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [] },
    }
    await writeFile(settings, JSON.stringify(theirs))

    const installed = await vb(['hooks', 'install', 'claude', 'codex'], at)
    expect(installed).toMatchObject({ code: 0, stderr: '' })
    expect(installed.stdout).toContain('Codex  ~/.codex/hooks.json\n  added the turn-end hook\n')
    // One short block per agent: home as ~, and what's allowed said in words, not as the rules' raw commands.
    expect(installed.stdout).toContain('Claude Code  ~/.claude/settings.json\n  added the turn-end hook\n  update, reply, and read run without asking\n\n')
    expect(installed.stdout).not.toContain('Bash(')
    expect(installed.stdout).not.toContain(home)
    expect(installed.stdout).toContain('They stay quiet outside projects linked with `vb link <url>`.\n')
    // Prose fits 80 columns; only the pasted config (indented four) and its domains can run over.
    expect(installed.stdout.split('\n').filter((line) => line.length > 80 && !line.startsWith('    '))).toEqual([])
    // Codex has no command allowlist; its sandbox needs network, so it's told how to allow just the board.
    expect(installed.stdout).toContain("to let vb reach the board from Codex's sandbox, add to ~/.codex/config.toml:\n\n    # a permission profile (beta) that opens the network to just the board\n\n    # at the top, before any [table]\n    default_permissions = \"vboard\"\n")
    expect(installed.stdout).toContain(`"${new URL(url).hostname}" = "allow"`)
    expect((await vb(['hooks', 'install', 'claude'], at)).stdout).toContain('Claude Code  ~/.claude/settings.json\n  already installed\n')
    const claude = JSON.parse(await readFile(settings, 'utf8'))
    expect(claude.model).toBe('opus')
    expect(claude.hooks.PreToolUse).toEqual([])
    expect(claude.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: expect.stringMatching(/ hook stop --agent claude 2>\/dev\/null \|\| true$/), timeout: 10 }] },
    ])
    const cli = (claude.hooks.Stop[1].hooks[0].command as string).replace(/ hook stop .*$/, '')
    expect(claude.permissions).toEqual({ allow: ['Bash(ls:*)', `Bash(${cli} update:*)`, `Bash(${cli} reply:*)`, `Bash(${cli} read:*)`], deny: ['Bash(rm:*)'] })
    const codex = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'))
    expect(codex.hooks.Stop[0].hooks[0].command).toMatch(/ hook stop --agent codex 2>\/dev\/null \|\| true$/)
    expect((await vb(['hooks', 'status'], at)).stdout).toBe('Claude Code  installed  ~/.claude/settings.json\nCodex        installed  ~/.codex/hooks.json\nCursor       not installed\nPi           not installed\n')

    // Whatever the saved command runs into (say, an older vb without `hook`, which exits 2), it can't fail a turn.
    const stale = join(home, 'bin')
    await mkdir(stale)
    await writeFile(join(stale, 'vb'), '#!/bin/sh\necho "error: unknown command: hook" >&2\nexit 2\n', { mode: 0o755 })
    const ran = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', 'vb hook stop --agent claude 2>/dev/null || true'], { env: { ...env, PATH: `${stale}:${process.env.PATH}` } })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code, stderr }))
      child.stdin.end('{}')
    })
    expect(ran).toEqual({ code: 0, stderr: '' })

    expect((await vb(['hooks', 'uninstall', 'claude'], at)).stdout).toBe('Claude Code  removed  ~/.claude/settings.json\n')
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual(theirs)
    expect((await vb(['hooks', 'install', 'gemini'], at))).toMatchObject({ code: 2, stderr: 'error: unknown agent: gemini (known: claude, codex, cursor, pi)\n' })
  })

  // pnpm installs global bins as shell scripts that exec node on the package, through its node_modules symlink:
  // pnpm 10 quotes "$basedir/…", pnpm 11 quotes "$basedir_abs/…" (and "$basedir_win/…" for Windows shells).
  const shims = {
    'pnpm 10': (rel: string) => [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'if [ -x "$basedir/node" ]; then',
      `  exec "$basedir/node"  "$basedir/${rel}" "$@"`,
      'else',
      `  exec node  "$basedir/${rel}" "$@"`,
      'fi',
    ],
    'pnpm 11': (rel: string) => [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'basedir_abs=$(cd "$basedir" && pwd)',
      'basedir_win=$basedir_abs',
      'case `uname` in',
      `    *CYGWIN*|*MINGW*|*MSYS*) exec node.exe  "$basedir_win/${rel}" "$@";;`,
      'esac',
      'if [ -x "$basedir/node" ]; then',
      `  exec "$basedir/node"  "$basedir_abs/${rel}" "$@"`,
      'else',
      `  exec node  "$basedir_abs/${rel}" "$@"`,
      'fi',
    ],
  }
  for (const [pnpm, shim] of Object.entries(shims)) {
    it(`reminds with plain vb when the vb on PATH is a ${pnpm} shim for this CLI`, async () => {
      const home = await tmp('vboard-home-')
      const bin = join(home, 'pnpm', 'bin')
      await mkdir(join(home, 'pnpm', 'global', 'node_modules'), { recursive: true })
      await mkdir(bin)
      await symlink(dirname(dirname(CLI)), join(home, 'pnpm', 'global', 'node_modules', 'vboard'))
      await writeFile(join(bin, 'vb'), `${shim('../global/node_modules/vboard/cli/main.ts').join('\n')}\n`, { mode: 0o755 })
      const at = { HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` }

      expect(await vb(['hooks', 'install', 'claude'], at)).toMatchObject({ code: 0, stderr: '' })
      const claude = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
      expect(claude.hooks.Stop[0].hooks[0].command).toBe('vb hook stop --agent claude 2>/dev/null || true')

      const repo = await tmp('vboard-repo-')
      execFileSync('git', ['init', '-q', '-b', 'feat/shim'], { cwd: repo })
      const { stdout } = await vb(['hook', 'stop', '--agent', 'claude'], at, JSON.stringify({ session_id: `shim-${Date.now()}`, cwd: repo }))
      const { reason } = JSON.parse(stdout) as { reason: string }
      expect(reason).toContain(': vb update "<summary>", or vb reply <id>')
      expect(reason).not.toContain(process.execPath)
    })
  }

  it('installs the Claude Code hook in CLAUDE_CONFIG_DIR when it is set', async () => {
    const home = await tmp('vboard-home-')
    const config = await tmp('vboard-claude-')
    const at = { HOME: home, CLAUDE_CONFIG_DIR: config }
    expect(await vb(['hooks', 'install', 'claude'], at)).toMatchObject({ code: 0, stderr: '' })
    const settings = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/ hook stop --agent claude /)
    expect(settings.permissions.allow).toHaveLength(3)
    expect(readdirSync(home)).toEqual([])
    expect((await vb(['hooks', 'status', 'claude'], at)).stdout).toBe(`Claude Code  installed  ${join(config, 'settings.json')}\n`)
    expect((await vb(['hooks', 'status', 'claude'], { HOME: home })).stdout).toBe('Claude Code  not installed\n')
    expect((await vb(['hooks', 'uninstall', 'claude'], at)).stdout).toContain('removed')
    expect(JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))).toEqual({ hooks: {}, permissions: { allow: [] } })
    expect(readdirSync(home)).toEqual([])
  }, 20_000)

  it("reminds an agent once when its turn didn't update the board, and the agent updates with vb", async () => {
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/hooks'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo })
    // Markers live in the temp directory: fresh session IDs keep runs apart.
    const s1 = `s1-${Date.now()}`
    const claude = { CLAUDE_CODE_SESSION_ID: s1 }
    const stop = (session: string, continuing = false, extra: NodeJS.ProcessEnv = {}) =>
      vb(['hook', 'stop', '--agent', 'claude'], extra, JSON.stringify({ session_id: session, cwd: repo, hook_event_name: 'Stop', stop_hook_active: continuing }))
    const reminds = async (result: Promise<{ stdout: string; code: number }>) => {
      const { stdout, code } = await result
      expect(code).toBe(0)
      return stdout ? (JSON.parse(stdout) as { decision: string; reason: string }) : null
    }
    const work = async () => {
      const { stdout } = await vb(['read', 'work', '--label', 'work=acme/app@feat/hooks', '--json'])
      return stdout.trim() ? stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; re: number | null; text: string; noSync: boolean; labels: Record<string, string>; by: { profile: string; session: string } }) : []
    }

    // A turn that didn't touch the board is reminded once, with the commands to run; the follow-up stops.
    const reminded = await reminds(stop(s1))
    expect(reminded).toMatchObject({ decision: 'block', reason: expect.stringContaining(' update "<summary>"') })
    expect(reminded!.reason).toContain(' update --skip')
    expect(await reminds(stop(s1, true))).toBeNull()

    // The agent updates with vb: the turn's end isn't reminded. The next turn, with no update, is.
    expect(await vb_in(repo, ['update', 'Added the turn-end hook; tests next.'], claude)).toMatchObject({ code: 0, stderr: '' })
    expect(await reminds(stop(s1))).toBeNull()
    expect(await reminds(stop(s1))).not.toBeNull()
    expect(await reminds(stop(s1))).toBeNull() // reminded already this turn
    await vb_in(repo, ['update', '--skip'], claude)
    expect(await reminds(stop(s1))).toBeNull()

    // Another agent's update on the same branch joins the same thread.
    await vb_in(repo, ['update', 'Picked it up in Codex; tests pass.'], { CODEX_THREAD_ID: 't1' })
    const [root, ...replies] = await work()
    expect(root).toMatchObject({ re: null, noSync: true, labels: { work: 'acme/app@feat/hooks', repo: 'acme/app', branch: 'feat/hooks' } })
    expect(replies.map((m) => [m.by.profile, m.by.session, m.text])).toEqual([
      ['claude', s1, 'Added the turn-end hook; tests next.'],
      ['codex', 't1', 'Picked it up in Codex; tests pass.'],
    ])

    // Past a page of messages on the branch, updates still find the thread instead of starting another.
    const rootId = root!.id
    for (let i = 0; i < 501; i++) {
      const posted = await fetch(`${url}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.VBOARD_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ re: rootId, text: `note ${i}`, noSync: true }),
      })
      expect(posted.status).toBe(201)
    }
    // From another session, so the root's stable id can't stand in for finding it.
    expect(await vb_in(repo, ['update', 'Still the same thread.'], { CODEX_THREAD_ID: `t2-${Date.now()}` })).toMatchObject({ code: 0, stderr: '' })
    const { stdout } = await vb(['read', String(rootId), '--json'])
    const thread = stdout.trim().split('\n').map((line) => JSON.parse(line) as { re: number | null; text: string })
    expect(thread).toHaveLength(1 + 2 + 501 + 1) // the root, two updates, the notes, and this one
    expect(thread.at(-1)).toMatchObject({ re: rootId, text: 'Still the same thread.' })

    // Outside a linked project, the hook stays out of the way.
    expect(await reminds(stop(`s2-${Date.now()}`, false, { VBOARD_URL: '' }))).toBeNull()
  }, 60_000)

  it('starts the work thread for a branch whose name is longer than an id may be', async () => {
    const repo = await tmp('vboard-repo-')
    const branch = `feat/${'very-long-branch-name-'.repeat(10)}`
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo })
    expect(await vb_in(repo, ['update', 'First update on a long branch.'])).toMatchObject({ code: 0, stderr: '' })
    expect(await vb_in(repo, ['update', 'Second one, same thread.'])).toMatchObject({ code: 0, stderr: '' })
    const { stdout } = await vb(['read', 'work', '--label', `work=acme/app@${branch}`, '--json'])
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line) as { re: number | null })
    expect(messages.filter((m) => m.re === null)).toHaveLength(1)
    expect(messages).toHaveLength(3)
  })

  it('reminds Cursor with a follow-up message, keyed by project since its shell has no session', async () => {
    const home = await tmp('vboard-home-')
    expect((await vb(['hooks', 'install', 'cursor'], { HOME: home })).stdout).toContain('Cursor  ~/.cursor/hooks.json\n  added the turn-end hook\n')
    expect(JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: expect.stringMatching(/ hook stop --agent cursor 2>\/dev\/null \|\| true$/), timeout: 10 }] },
    })

    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/cursor'], { cwd: repo })
    const stop = (payload: Record<string, unknown>) =>
      vb(['hook', 'stop', '--agent', 'cursor'], {}, JSON.stringify({ conversation_id: `c-${Date.now()}`, workspace_roots: [repo], hook_event_name: 'stop', ...payload }))

    expect(JSON.parse((await stop({ status: 'completed', loop_count: 0 })).stdout)).toEqual({ followup_message: expect.stringContaining(' update "<summary>"') })
    expect((await stop({ status: 'completed', loop_count: 1 })).stdout).toBe('')
    // The agent updates from Cursor's shell, which says only CURSOR_AGENT=1: the project's next turn end isn't reminded.
    expect(await vb_in(repo, ['update', 'Renamed the helper.'], { CURSOR_AGENT: '1' })).toMatchObject({ code: 0, stderr: '' })
    expect((await stop({ status: 'completed', loop_count: 0 })).stdout).toBe('')
    const { stdout } = await vb(['read', 'work', '--label', `work=${basename(repo)}@feat/cursor`, '--json'])
    expect(stdout.trim().split('\n').map((line) => JSON.parse(line)).filter((m) => m.re !== null).map((m) => [m.by.profile, m.text])).toEqual([['cursor', 'Renamed the helper.']])
    // An aborted turn isn't reminded.
    expect((await stop({ status: 'aborted', loop_count: 0 })).stdout).toBe('')

    // Uninstalling removes the file it created.
    expect((await vb(['hooks', 'uninstall', 'cursor'], { HOME: home })).stdout).toContain('removed')
    await expect(readFile(join(home, '.cursor', 'hooks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("reminds Pi through an extension before its run settles, once, and not after it updates with vb", async () => {
    const home = await tmp('vboard-home-')
    const agentDir = join(home, 'pi-agent')
    const at = { HOME: home, PI_CODING_AGENT_DIR: agentDir }
    const file = join(agentDir, 'extensions', 'vboard.ts')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('Pi  ~/pi-agent/extensions/vboard.ts\n  added the turn-end hook\n')
    expect((await vb(['hooks', 'install', 'pi'], at)).stdout).toContain('  already installed\n')
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toBe('Pi  installed  ~/pi-agent/extensions/vboard.ts\n')

    // Load it as Pi does, with a stand-in for Pi's API, and run its handler as Pi would before settling.
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
    const { default: extension } = await import(file)
    extension({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => (handlers[name] = handler) })
    expect(Object.keys(handlers)).toEqual(['agent_before_settle'])
    const repo = await tmp('vboard-repo-')
    execFileSync('git', ['init', '-q', '-b', 'feat/pi'], { cwd: repo })
    const session = `pi-${Date.now()}`
    const ctx = { cwd: repo, sessionManager: { getSessionId: () => session } }
    const settle = (outcome = 'completed') => handlers.agent_before_settle!({ type: 'agent_before_settle', outcome, entries: [], continue: false }, ctx)
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    try {
      // A run that didn't touch the board continues once, with the reminder as a message; the follow-up settles.
      expect(await settle()).toEqual({
        entries: [{ type: 'custom_message', customType: 'vboard', content: expect.stringContaining(' update "<summary>"'), display: true }],
        continue: true,
      })
      expect(await settle()).toBeUndefined()
      // Pi's bash tool exports the session as PI_SESSION_ID: its update counts, so the next run settles freely.
      expect(await vb_in(repo, ['update', 'Taught Pi the hook.'], { PI_CODING_AGENT: 'true', PI_SESSION_ID: session })).toMatchObject({ code: 0, stderr: '' })
      expect(await settle()).toBeUndefined()
      // An aborted run isn't reminded.
      expect(await settle('aborted')).toBeUndefined()
      expect(await settle()).toMatchObject({ continue: true })
    } finally {
      vi.unstubAllEnvs()
    }
    const { stdout } = await vb(['read', 'work', '--label', `work=${basename(repo)}@feat/pi`, '--json'])
    expect(stdout.trim().split('\n').map((line) => JSON.parse(line)).filter((m) => m.re !== null).map((m) => [m.by.profile, m.by.session, m.text])).toEqual([['pi', session, 'Taught Pi the hook.']])

    // It won't overwrite an extension that isn't its own; uninstalling removes only its file.
    expect((await vb(['hooks', 'uninstall', 'pi'], at)).stdout).toBe('Pi  removed  ~/pi-agent/extensions/vboard.ts\n')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, 'export default () => {}\n')
    expect(await vb(['hooks', 'install', 'pi'], at)).toMatchObject({ code: 1, stderr: `error: ${file} isn't vboard's: move it, then install again\n` })
    expect((await vb(['hooks', 'status', 'pi'], at)).stdout).toBe('Pi  not installed\n')
    expect(await readFile(file, 'utf8')).toBe('export default () => {}\n')
  }, 30_000)
})
