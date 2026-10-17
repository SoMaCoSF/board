// `vboard/tools`: the vb CLI as an AI SDK tool. An agent on a board posts on purpose, with
// the same commands people use, and reads what's new with `vb notifications`. In an A2 agent
// the board runs, `vb` knows which agent it is; anywhere else, `vbFor(board)` says.
import { handlerContext } from 'experimental-a2/ai'
import { tool, type Experimental_SandboxSession, type Tool } from 'ai'
import { z } from 'zod'
import { duration, type BoardClient } from '../client/client.ts'
import { BOARD_COMMANDS, helpFor, parse, runCommand, UsageError, type CommandFiles, type CommandIO } from '../cli/commands.ts'
import { RUNNING_AGENTS } from '../server/agents.ts'

/**
 * What the `vb` tool runs: every board command the CLI has, but `tail`, which runs until it's stopped and
 * so never returns a tool call (`wait` is the one that does). The rest of the CLI is about a machine: linking
 * a checkout, hooks, a local board, the inspector.
 */
export const AGENT_COMMANDS = BOARD_COMMANDS.filter((command) => command !== 'tail')

/** Flags about who's calling, which the tool decides: it always acts as the agent. */
const IDENTITY_FLAGS = ['url', 'as', 'avatar', 'human', 'handle'] as const
const WAIT_DEFAULT = '2m'
/** A tool call lives in one function invocation; A2 doesn't say how long that has, so `wait` stops here. */
const WAIT_MAX = 10 * 60_000

type VbInput = { command: string; input?: string | undefined }

const DESCRIPTION = `The vboard CLI, as you: you're an agent on a vboard message board, and this is how you read it and talk on it. Nothing you write as plain text reaches anyone; what you post with this tool does. When you're woken with new notifications, read them with \`notifications\`, then \`read <thread>\` before you act, and \`reply <thread> "…"\` when you have something to say. Same commands, flags, and output as \`vb\`; text with quotes or newlines can go in \`input\`, passed as "-".`

const inputSchema = z.object({
  command: z.string().describe('The command line, as you would type it: `reply 123 "On it"`. A leading `vb` is fine.'),
  input: z.string().optional().describe('What a "-" argument reads, like stdin: long or multi-line text.'),
})

const result = ({ code, output }: { code: number; output: string }) => (code === 0 ? output : `${output}${output ? '\n' : ''}(exit ${code})`)

/** The A2 agent running this tool call, as a board knows it, and its session. */
function running(): { client(options: { key?: string; session?: string }): BoardClient; session: string } {
  for (const entry of RUNNING_AGENTS.values()) {
    let session: string
    try {
      session = handlerContext(entry.contract as never).session.id
    } catch {
      continue
    }
    return { client: entry.client, session }
  }
  throw new UsageError("vb runs inside an agent a board runs (board({ agents })); anywhere else, use vbFor(board)")
}

/**
 * The vb CLI as an AI SDK tool, for an A2 agent a board runs: `agent({ tools: { vb } })`, then
 * `board({ agents: { helper } })`. It acts as that agent, in the session it's running in.
 */
export const vb: Tool<VbInput, string> = tool({
  description: `${DESCRIPTION}\n\n${helpFor(AGENT_COMMANDS)}`,
  inputSchema,
  execute: async ({ command, input }, { toolCallId, abortSignal, experimental_sandbox }) => {
    let agent: ReturnType<typeof running>
    try {
      agent = running()
    } catch (error) {
      return result({ code: 2, output: `error: ${(error as Error).message}` })
    }
    return result(
      await runVb(command, {
        // Scoped by session: a provider may reuse a call ID like `call_0` from one turn to the next.
        client: () => agent.client({ key: `${agent.session}:${toolCallId}`, session: agent.session }),
        input,
        sandbox: experimental_sandbox,
        signal: abortSignal,
      }),
    )
  },
})

/**
 * The vb CLI as an AI SDK tool for any harness: it acts as whoever `board` writes as, like the `board` a
 * function `run` gets, or a client from `createClient`.
 */
export function vbFor(board: BoardClient): Tool<VbInput, string> {
  return tool({
    description: `${DESCRIPTION}\n\n${helpFor(AGENT_COMMANDS)}`,
    inputSchema,
    execute: async ({ command, input }, { abortSignal, experimental_sandbox }) =>
      result(await runVb(command, { client: () => board, input, sandbox: experimental_sandbox, signal: abortSignal })),
  })
}

/** Runs one `vb` command line the way the CLI would, collecting what it prints. */
export async function runVb(
  line: string,
  options: { client: CommandIO['client']; input?: string | undefined; sandbox?: Experimental_SandboxSession | undefined; signal?: AbortSignal | undefined },
): Promise<{ code: number; output: string }> {
  const lines: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const io: CommandIO = {
    client: options.client,
    out: (text) => lines.push(text),
    err: (text) => lines.push(text),
    write: (data) => {
      try {
        lines.push(decoder.decode(data))
      } catch {
        lines.push(`(${data.byteLength} bytes that aren't text: save them to a file instead)`)
      }
    },
    stdin: async () => {
      if (options.input === undefined) throw new UsageError('"-" reads the tool\'s input, and there is none')
      return options.input
    },
    files: options.sandbox ? sandboxFiles(options.sandbox) : null,
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const done = (code: number) => ({ code, output: lines.join('\n') })
  try {
    const argv = split(line)
    if (argv[0] === 'vb' || argv[0] === 'vboard') argv.shift()
    const { values: flags, positionals } = parse(argv)
    const [command, ...args] = positionals
    if (!command || command === 'help' || flags.help) return lines.push(helpFor(AGENT_COMMANDS)), done(0)
    if (command === 'tail') throw new UsageError("tail runs until it's stopped, so it can't answer a tool call: use wait")
    if (!(AGENT_COMMANDS as readonly string[]).includes(command))
      throw new UsageError(`${command} is about a machine, not the board; these are: ${AGENT_COMMANDS.join(', ')}`)
    const identity = IDENTITY_FLAGS.find((flag) => flags[flag] !== undefined)
    if (identity) throw new UsageError(`--${identity} doesn't apply here: you always act as yourself on this board`)
    if (command === 'wait') {
      let ms: number
      try {
        ms = duration(flags.timeout ?? WAIT_DEFAULT)
      } catch (error) {
        throw new UsageError((error as Error).message)
      }
      if (ms > WAIT_MAX) throw new UsageError(`--timeout is at most 10m here, got: ${flags.timeout}`)
      flags.timeout = flags.timeout ?? WAIT_DEFAULT
    }
    const code = await runCommand(command, args, flags, io)
    return done(code ?? 2)
  } catch (error) {
    lines.push(`error: ${(error as Error).message}`)
    return done(error instanceof UsageError || error instanceof TypeError ? 2 : 1)
  }
}

function sandboxFiles(sandbox: Experimental_SandboxSession): CommandFiles {
  return {
    stat: async (path) => {
      const data = await sandbox.readBinaryFile({ path })
      return data ? { size: data.byteLength } : null
    },
    read: async (path) => {
      const data = await sandbox.readBinaryFile({ path })
      if (!data) throw new UsageError(`no such file: ${path}`)
      return new Uint8Array(data)
    },
    write: async (path, data) => {
      await sandbox.writeBinaryFile({ path, content: data })
    },
    basename: (path) => path.slice(path.lastIndexOf('/') + 1) || path,
  }
}

/**
 * Splits a command line the way a shell would, without expanding anything: whitespace
 * separates words, '…' is literal, "…" and a bare backslash escape the next character.
 */
export function split(line: string): string[] {
  const words: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quote === "'") {
      if (char === "'") quote = null
      else word = (word ?? '') + char
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) word = (word ?? '') + line[++i]!
      else word = (word ?? '') + char
    } else if (char === "'" || char === '"') {
      quote = char
      word ??= ''
    } else if (char === '\\') {
      if (i + 1 < line.length) word = (word ?? '') + line[++i]!
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word)
      word = null
    } else word = (word ?? '') + char
  }
  if (quote) throw new UsageError(`unclosed ${quote} in the command`)
  if (word !== null) words.push(word)
  return words
}
