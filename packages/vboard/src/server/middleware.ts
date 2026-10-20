import type { BoardClient } from '../client/client.ts'
import type { Actor } from '../contract/reducers.ts'
import { z } from 'zod'
import { Labels, MESSAGE_TEXT_MAX, type Attachment } from '../contract/schemas.ts'
import { HttpError } from './errors.ts'

/** Where a write came from. */
export type WriteSource =
  /** The HTTP API: the CLI, the SDK, scripts, CI. */
  | { kind: 'api' }
  /** A synced platform's event, or a sync callback's own writes. `thread` is the platform thread. */
  | { kind: 'sync'; key: string; platform: string; channel: string; thread: string }
  /** An in-process client from `board(...).client(name)`. */
  | { kind: 'client'; name: string }
  /** A watcher's in-process client. */
  | { kind: 'watcher'; id: string }
  /** A scheduled message's send. */
  | { kind: 'schedule'; id: number }
  /** A declared agent's in-process client, from `board(...).agent(key)` or the agent's own `vb` tool. */
  | { kind: 'agent'; key: string }

/** The message a write would put on the board. */
export type Write =
  | { kind: 'post'; channel: string; re: number | null; text: string; labels: Labels; attachments: readonly Attachment[] }
  | { kind: 'edit'; id: number; channel: string; re: number | null; text: string }

/** What `next` may change before the write lands. Labels apply to posts only. */
export type WritePatch = { text?: string; labels?: Labels }

export type MiddlewareContext = {
  write: Readonly<Write>
  /** Who's writing. */
  author: Readonly<Actor>
  source: Readonly<WriteSource>
  /**
   * Tells whoever wrote it, where they wrote it from: a reply in their platform
   * thread for sync, the error message the API answers with otherwise.
   */
  respond(text: string): Promise<void>
  /** Writes as `vboard:middleware`. Its writes skip the middleware. */
  board: BoardClient
  /**
   * Hands the write to the next middleware, and after the last one, to the board.
   * Not calling it drops the write, and so does emptying a write that has no files.
   */
  next(patch?: WritePatch): Promise<void>
}

export type Middleware = (context: MiddlewareContext) => unknown

/** A write the middleware didn't let through: the API answers 422 with what it responded. */
export class DroppedError extends HttpError {
  constructor(message: string) {
    super(422, 'dropped', message)
  }
}

const Patch = z.object({ text: z.string().max(MESSAGE_TEXT_MAX).optional(), labels: Labels.optional() }).strict()

export const MIDDLEWARE_ACTOR = 'vboard:middleware'

/**
 * Runs `write` through `middleware` in order, then `commit`s what the last one
 * passed on. Throws `DroppedError` when one doesn't call `next`.
 */
export async function runMiddleware<W extends Write, T>(
  middleware: readonly Middleware[],
  input: { write: W; author: Actor; source: WriteSource; board: () => BoardClient; respond?: (text: string) => Promise<void> },
  commit: (write: W) => Promise<T>,
): Promise<T> {
  const responses: string[] = []
  let committed: { value: T } | null = null
  const step = async (i: number, write: W): Promise<void> => {
    if (i === middleware.length) {
      // Emptied on the way, like a redaction that left nothing: there's nothing to post.
      if (write.text.trim() === '' && (write.kind === 'edit' || write.attachments.length === 0)) return
      committed = { value: await commit(write) }
      return
    }
    let next: Promise<void> | null = null
    await middleware[i]!({
      write: Object.freeze({ ...write }),
      author: Object.freeze({ ...input.author }),
      source: Object.freeze({ ...input.source }),
      board: input.board(),
      respond: async (text) => {
        responses.push(text)
        await input.respond?.(text)
      },
      next: (patch = {}) => {
        if (next) throw new Error('next() was already called')
        const { text, labels } = Patch.parse(patch)
        next = step(i + 1, {
          ...write,
          ...(text !== undefined ? { text } : {}),
          ...(write.kind === 'post' && labels ? { labels: { ...write.labels, ...labels } } : {}),
        })
        return next
      },
    })
    // A middleware that called `next` without awaiting it still lets the write through.
    if (next) await next
  }
  await step(0, input.write)
  if (!committed) throw new DroppedError(responses.join('\n') || 'the board dropped this message')
  return (committed as { value: T }).value
}
