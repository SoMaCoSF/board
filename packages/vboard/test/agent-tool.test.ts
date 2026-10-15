import type { Experimental_SandboxSession } from 'ai'
import { describe, expect, it } from 'vitest'
import { AGENT_COMMANDS, runVb, split, vbTool } from '../src/agents/index.ts'
import { helpFor } from '../src/cli/commands.ts'
import { testBoard } from './harness.ts'

/** A sandbox that's only a filesystem, in memory. */
function fakeSandbox(files: Record<string, Uint8Array> = {}) {
  const sandbox = {
    readBinaryFile: async ({ path }: { path: string }) => files[path] ?? null,
    writeBinaryFile: async ({ path, content }: { path: string; content: Uint8Array }) => void (files[path] = content),
  } as unknown as Experimental_SandboxSession
  return { sandbox, files }
}

function setup() {
  const instance = testBoard({ agents: { helper: { name: 'Helper' } } })
  const as = (key: string) => () => instance.agent('helper', { key })
  return { instance, as }
}

describe('the vb tool', () => {
  it('splits a command line like a shell, expanding nothing', () => {
    expect(split(`reply 12 "it's \\"fixed\\"" --label 'a=$HOME' b\\ c`)).toEqual(['reply', '12', `it's "fixed"`, '--label', 'a=$HOME', 'b c'])
    expect(split(`post dev ""`)).toEqual(['post', 'dev', ''])
    expect(split('post dev "two\nlines"')).toEqual(['post', 'dev', 'two\nlines'])
    expect(() => split(`reply 1 "open`)).toThrow('unclosed " in the command')
  })

  it('runs the CLI’s commands as the agent, and a rerun of the same call posts nothing new', async () => {
    const { instance, as } = setup()
    const root = await instance.client('test').post('dev', { text: 'how do I wait?' })

    const first = await runVb(`vb reply ${root.id} "use vb wait"`, { client: as('call-1') })
    const again = await runVb(`reply ${root.id} "use vb wait"`, { client: as('call-1') })
    expect(first).toEqual({ code: 0, output: expect.stringMatching(/^\d+$/) })
    expect(again.output).toBe(first.output)

    const thread = await instance.client('test').thread(root.id)
    expect(thread.replies).toHaveLength(1)
    expect(thread.replies[0]).toMatchObject({ text: 'use vb wait', by: { actor: 'vboard:agent:helper' } })
    expect((await runVb(`read ${root.id}`, { client: as('call-2') })).output).toContain('use vb wait')
    expect(JSON.parse((await runVb('whoami --json', { client: as('call-3') })).output)).toMatchObject({ actor: 'vboard:agent:helper' })
  })

  it('reads "-" from its input', async () => {
    const { instance, as } = setup()
    const root = await instance.client('test').post('dev', { text: 'long one' })
    await runVb(`reply ${root.id} -`, { client: as('call-1'), input: 'line one\nline two' })
    expect((await instance.client('test').thread(root.id)).replies[0]!.text).toBe('line one\nline two')
    expect(await runVb(`reply ${root.id} -`, { client: as('call-2') })).toEqual({ code: 2, output: `error: "-" reads the tool's input, and there is none` })
  })

  it('acts only as the agent, with every board command but tail', async () => {
    const { as } = setup()
    expect(await runVb('read 1 --as pi', { client: as('x') })).toEqual({ code: 2, output: "error: --as doesn't apply here: you always act as yourself on this board" })
    expect(await runVb('read 1 --url https://elsewhere.test', { client: as('x') })).toMatchObject({ code: 2 })
    // The board's plumbing too: the agent has the access, so it has the commands.
    expect(await runVb('sources', { client: as('x') })).toEqual({ code: 0, output: 'no sources: this board has no sync configured' })
    expect(await runVb('stuck', { client: as('x') })).toEqual({ code: 0, output: 'nothing is stuck' })
    expect(await runVb('tail dev', { client: as('x') })).toEqual({ code: 2, output: "error: tail runs until it's stopped, so it can't answer a tool call: use wait" })
    expect((await runVb('link https://elsewhere.test', { client: as('x') })).output).toBe(`error: link is about a machine, not the board; these are: ${AGENT_COMMANDS.join(', ')}`)
    expect((await runVb('wait dev --timeout 1h', { client: as('x') })).output).toBe('error: --timeout is at most 10m here, got: 1h')
    expect(await runVb('help', { client: as('x') })).toEqual({ code: 0, output: helpFor(AGENT_COMMANDS) })
    expect((await runVb('read 999', { client: as('x') })).code).toBe(1)
  })

  it('attaches and downloads through the sandbox, and says so without one', async () => {
    const { instance, as } = setup()
    const root = await instance.client('test').post('dev', { text: 'screenshot?' })
    const { sandbox, files } = fakeSandbox({ '/work/shot.txt': new TextEncoder().encode('pixels') })

    const posted = await runVb(`reply ${root.id} "here" --attach /work/shot.txt --json`, { client: as('call-1'), sandbox })
    const [file] = JSON.parse(posted.output).attachments
    expect(file).toMatchObject({ name: 'shot.txt' })
    expect(await runVb(`download ${file.id} /work/copy.txt`, { client: as('call-2'), sandbox })).toEqual({ code: 0, output: '/work/copy.txt' })
    expect(new TextDecoder().decode(files['/work/copy.txt'])).toBe('pixels')
    expect((await runVb(`download ${file.id} -`, { client: as('call-3') })).output).toBe('pixels')

    expect(await runVb(`reply ${root.id} "here" --attach shot.txt`, { client: as('call-4') })).toEqual({ code: 2, output: 'error: there are no files here to attach' })
  })

  it('describes itself with the CLI’s own help, and reports a failed command’s exit code', async () => {
    const { as } = setup()
    const vb = vbTool({ name: 'Helper', client: as('call-1') })
    expect(vb.description).toContain(helpFor(AGENT_COMMANDS))
    const result = await vb.execute!({ command: 'react 1' }, { toolCallId: 'call-1', messages: [], context: {} })
    expect(result).toBe('error: usage: vboard react <id> <emoji> [--remove]\n(exit 2)')
  })
})
