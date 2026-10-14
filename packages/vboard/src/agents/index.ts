// `vboard/agents`: an agent the board runs on A2. `agent()` describes one; the
// board builds it with A2's `agent()`, its own store and scheduler, and a `vb`
// tool. The board wakes it with notifications, never with message text, and
// it posts only through that tool: what it writes as plain text reaches no one.
import { idempotentId, reducer } from 'experimental-a2'
import {
  agentContract,
  handlerContext,
  inputs,
  type AIState,
  type ControlReceipt,
  type GenerationFailedPayload,
  type UIMessage,
} from 'experimental-a2/ai'
import { agent as a2Agent, type AISDKHarness, type Harness, type ModelSettings, type ToolRecovery } from 'experimental-a2/ai/server'
import { tool, type Experimental_SandboxSession, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { duration } from '../client/client.ts'
import { helpFor, parse, runCommand, UsageError, type CommandFiles, type CommandIO } from '../cli/commands.ts'
import type { AgentIdentity } from '../server/actors.ts'
import type { AgentConfig, AgentHost, AgentRuntime, Notification } from '../server/agents.ts'

export type { AgentConfig, AgentHost, AgentRuntime, Notification, NotifyContext } from '../server/agents.ts'

/** What `agent()` takes: who the agent is, its model, and when the board wakes it. */
export type AgentOptions<T extends ToolSet = ToolSet> = AgentIdentity &
  Pick<AgentConfig, 'notify' | 'session'> & {
    /** An AI Gateway model ID, like `'anthropic/claude-opus-5.5'`, or A2's `ModelSettings`. */
    model: string | ModelSettings
    /** Yours, after the board's own: who the agent is on the board and how it replies. */
    instructions?: string
    /** Tools besides `vb`, which every agent gets. */
    tools?: T
    /** A2's harness, like `pi({ sandbox })`: `vb --attach` and `download` use its sandbox. */
    harness?: Harness<'fx' | 'pi'> | AISDKHarness
    maxSteps?: number
    /** Per tool name: rerun a call a crash cut short (A2's default), or report it to the model. */
    toolRecovery?: Readonly<Partial<Record<string, ToolRecovery>>>
  }

/** What the `vb` tool runs: the CLI's board commands, minus the ones about sync and its plumbing. */
export const AGENT_COMMANDS = [
  'whoami', 'channels', 'actors', 'read', 'post', 'reply', 'edit', 'delete', 'react', 'label', 'typing',
  'schedule', 'schedules', 'subscribe', 'unsubscribe', 'download', 'wait',
] as const

/** Flags about who's calling, which the tool decides: it always acts as the agent. */
const IDENTITY_FLAGS = ['url', 'as', 'avatar', 'human', 'handle'] as const
const WAIT_DEFAULT = '2m'
const WAIT_MAX = 10 * 60_000

/** The wakeups' bookkeeping, in each wakeup message's metadata. */
type WakeMetadata = { vboard: { notifications: Notification[] } }

/**
 * An agent the board runs: `board({ agents: { helper: agent({ name: 'Helper', model, instructions }) } })`.
 * Mentions of `@helper`, and new replies in threads it follows, wake it in A2 session
 * `thread-<root>`; it answers with its `vb` tool.
 */
export function agent<T extends ToolSet = ToolSet>(options: AgentOptions<T>): AgentConfig {
  const { model, instructions, tools, harness, maxSteps, toolRecovery, notify, session, ...identity } = options
  return {
    ...identity,
    ...(notify ? { notify } : {}),
    ...(session !== undefined ? { session } : {}),
    run: (host) => runtime(host, { model, instructions, tools, harness, maxSteps, toolRecovery }),
  }
}

function runtime(host: AgentHost, options: Omit<AgentOptions, keyof AgentIdentity | 'notify' | 'session'>): AgentRuntime {
  const contract = agentContract({ name: `vboard-agent-${host.key}` })

  // Edit commands this runtime sent, until A2 decides them: one A2 rejects lost a
  // race with its turn starting, so its notification goes out again.
  const pendingEdits = reducer({ contract, name: 'vboard.agent.edits.v1', initialState: {} as Record<string, Notification> }).fold(
    (state, event) => {
      if (event.type === 'ai.control.requested') {
        const command = event.payload as { action: string; message?: UIMessage }
        const added = wakeOf(command.message)?.at(-1)
        if (command.action === 'edit' && added && event.id) state[event.id] = added
      } else if (event.type === 'ai.control.decided') delete state[(event.payload as { commandId: string }).commandId]
      return state
    },
  )

  const server = a2Agent({
    contract,
    ...(host.store ? { store: host.store } : {}),
    ...(host.scheduler ? { scheduler: host.scheduler } : {}),
    model: options.model,
    instructions: [preamble(host), options.instructions].filter(Boolean).join('\n\n'),
    tools: { ...options.tools, vb: vbTool(host) },
    ...(options.harness ? { harness: options.harness } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.toolRecovery ? { toolRecovery: options.toolRecovery } : {}),
    handlers: {
      'ai.control.decided': async (ctx) => {
        const receipt = ctx.event.payload as ControlReceipt
        if (receipt.outcome !== 'rejected') return
        const { state } = await ctx.session.state(pendingEdits, { through: ctx.event.index - 1 })
        const lost = state[receipt.commandId]
        if (lost) await host.retry(lost, receipt.commandId)
      },
      // A turn that failed would hold every wakeup queued behind it. Stop it, and say so
      // in its threads as the board, never as the agent; the next reply starts a fresh one.
      'ai.generation.failed': async (ctx) => {
        const failed = ctx.event.payload as GenerationFailedPayload
        if (failed.superseded) return
        const { state } = (await ctx.session.state()) as { state: AIState }
        const active = state.active?.turnId === failed.messageId ? state.active : null
        const turn = active ? active.input.message : state.messages.find((m) => m.id === failed.messageId)
        if (active) await ctx.session.append(`stop:${failed.generationId}`, ...inputs.stop({ turnId: active.turnId }))
        const reason = failed.stepLimit ? 'it ran out of steps' : (failed.error.split('\n')[0] ?? '').slice(0, 200) || 'its model failed'
        const threads = [...new Set((wakeOf(turn) ?? []).map((n) => n.thread))]
        for (const thread of threads)
          await host.notice(thread, `${host.name} couldn't finish: ${reason}. Reply to try again.`, `failed:${failed.generationId}`)
      },
    },
  } as Parameters<typeof a2Agent>[0])

  async function wake(notification: Notification): Promise<void> {
    const session = server.session(notification.session)
    const { state } = (await session.state()) as { state: AIState }
    const queue = queued(state)
    const seen = [...queue.map((item) => item.message), ...state.messages]
    if (seen.some((message) => wakeOf(message)?.some((n) => n.id === notification.id))) return
    // Behind a running turn, or another wakeup, the last queued wakeup takes this one too:
    // a burst costs one turn.
    const waiting = queue.filter((item) => item.generate)
    const last = waiting.at(-1)
    const earlier = last ? wakeOf(last.message) : null
    if (last && earlier && (state.active !== null || waiting.length > 1)) {
      const [edit] = inputs.queue.edit({ message: wakeMessage(last.id, [...earlier, notification]) })
      await session.append({ ...edit!, id: await idempotentId('vboard.wake.edit', host.key, notification.id, last.id) })
      return
    }
    const message = wakeMessage(await idempotentId('vboard.wake', host.key, notification.id), [notification])
    await session.append(...inputs.message(message))
  }

  return { servers: [server as never], wake }
}

/** The session's queue as it will be: its inbox, then the sends and edits A2 hasn't decided yet. */
function queued(state: AIState): { id: string; message: UIMessage; generate: boolean }[] {
  const queue = state.inbox.items.map((item) => ({ id: item.id, message: item.message, generate: item.generate }))
  for (const { command } of state.pendingQueueCommands ?? []) {
    if (command.action === 'send') queue.push({ id: command.message.id, message: command.message, generate: command.generate !== false })
    else if (command.action === 'edit') {
      const item = queue.find((candidate) => candidate.id === command.message.id)
      if (item) item.message = command.message
    } else if (command.action === 'remove') {
      const at = queue.findIndex((item) => item.id === command.inputId)
      if (at >= 0) queue.splice(at, 1)
    }
  }
  return queue
}

function wakeOf(message: { metadata?: unknown } | undefined): Notification[] | null {
  const metadata = message?.metadata as Partial<WakeMetadata> | undefined
  return metadata?.vboard?.notifications ?? null
}

function wakeMessage(id: string, notifications: Notification[]): UIMessage {
  const lines = notifications.map((n) => {
    const who = `@${n.by.handle}${n.by.name && n.by.name !== n.by.handle ? ` (${n.by.name})` : ''}`
    const where = `thread #${n.thread} in ${n.channel}`
    const what =
      n.reason === 'reply' ? `replied in ${where}, which you follow: #${n.message}`
      : n.message === n.thread ? `mentioned you in a new thread, #${n.thread} in ${n.channel}`
      : `mentioned you in #${n.message}, a reply in ${where}`
    return `${who} ${what}. Read it with \`vb read ${n.thread}\`.`
  })
  const text = lines.length === 1 ? `New notification: ${lines[0]}` : `New notifications:\n${lines.map((line) => `- ${line}`).join('\n')}`
  return { id, role: 'user', parts: [{ type: 'text', text }], metadata: { vboard: { notifications } } satisfies WakeMetadata }
}

function preamble(host: AgentHost): string {
  return `You are ${host.name} (@${host.key}) on a vboard message board. People reach you by mentioning @${host.key}; you also hear about new replies in the threads you follow.

Each user message here is a notification from the board, not a message from a person. It says who, why, and where; read the thread with \`vb read <thread>\` before you act.

Nothing you write as plain text reaches anyone: it's your scratchpad. You talk on the board only through the vb tool, which is the vboard CLI: \`vb reply <thread> "…"\` answers in a thread. Reply when you have something to say, and say nothing when a message isn't for you. \`vb unsubscribe <thread>\` stops a thread's notifications.`
}

/** The `vb` tool: the CLI's board commands, as the agent, with the CLI's own output. */
export function vbTool(host: Pick<AgentHost, 'client' | 'name'>): Tool<{ command: string; input?: string | undefined }, string> {
  return tool({
    description: `Run a vboard CLI command on this board, as ${host.name}: the same commands, flags, and output as \`vb\`. Text with quotes or newlines can go in \`input\`, passed as "-".\n\n${helpFor(AGENT_COMMANDS)}`,
    inputSchema: z.object({
      command: z.string().describe('The command line, as you would type it: `reply 123 "On it"`. A leading `vb` is fine.'),
      input: z.string().optional().describe('What a "-" argument reads, like stdin: long or multi-line text.'),
    }),
    execute: async ({ command, input }, { toolCallId, abortSignal, experimental_sandbox }) => {
      let session: string | undefined
      try {
        session = handlerContext().session.id
      } catch {}
      const result = await runVb(command, {
        // Scoped by session: a provider may reuse a call ID like `call_0` from one turn to the next.
        client: () => host.client({ key: session ? `${session}:${toolCallId}` : toolCallId, ...(session ? { session } : {}) }),
        input,
        sandbox: experimental_sandbox,
        signal: abortSignal,
      })
      return result.code === 0 ? result.output : `${result.output}${result.output ? '\n' : ''}(exit ${result.code})`
    },
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
    if (!(AGENT_COMMANDS as readonly string[]).includes(command))
      throw new UsageError(`${command} isn't a command here; these are: ${AGENT_COMMANDS.join(', ')}`)
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
