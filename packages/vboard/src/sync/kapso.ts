import { ChatSyncProvider, type ChatInput } from './chat-provider.ts'
import type { MessageView } from '../api/routes.ts'
import type { Adapter, Message as ChatMessage } from 'chat'
import { markdownOf } from './chat.ts'
import { z } from 'zod'
import { envelope, eventSchema } from './events.ts'
import type { ResolvedTarget, SyncContext, SyncHandler, EventMapping, RenderInput } from './provider.ts'

type Raw = { kapso?: { transcript?: { text?: unknown } } } | null
type Sent = { responses?: { messages?: { id?: string }[] }[] } | null

// Kapso's thread IDs base64url-encode each part. The parts are phone number IDs,
// WhatsApp IDs (digits), and conversation IDs, so the board writes them as they are.
const decode = (id: string) => id.split(':').map((part) => Buffer.from(part, 'base64url').toString('utf8')).join(':')
const encode = (id: string) => id.split(':').map((part) => Buffer.from(part, 'utf8').toString('base64url')).join(':')

export const WhatsAppEvent = eventSchema('whatsapp', 'message')
export type WhatsAppEvent = z.infer<typeof WhatsAppEvent>

type MarkRead = (input: { phoneNumberId: string; messageId: string; typingIndicator: { type: 'text' } }) => Promise<unknown>
export type KapsoHandler = SyncHandler<WhatsAppEvent>
export type KapsoOptions = {
  adapter: Adapter
  /** Which of the board's messages WhatsApp gets: every one unless this says otherwise. */
  deliver?: (message: Readonly<MessageView>) => boolean
  render?: (input: RenderInput) => string
  markRead: MarkRead
  numbers: Record<string, EventMapping<WhatsAppEvent>>
}

/**
 * Syncs WhatsApp numbers on Kapso with board channels. Keys are phone number
 * IDs (`'16315558151'`); values are a board channel (a two-way mirror) or a
 * callback that handles every incoming event. Each Kapso conversation is a
 * thread. WhatsApp has no threads in a number, so a board thread never starts
 * one: a board root in a mirrored channel stays on the board.
 */
export function kapso(options: KapsoOptions): KapsoProvider {
  return new KapsoProvider(options)
}

export class KapsoProvider extends ChatSyncProvider<WhatsAppEvent> {
  constructor(options: KapsoOptions) {
    if (typeof options.markRead !== 'function') throw new Error('kapso requires a public markRead operation for cross-instance read and typing')
    const fileIds = (raw: unknown) => ((raw as Sent)?.responses ?? []).flatMap((response) => response.messages?.[0]?.id ?? [])
    super({
      fileIds,
      ...(options.deliver ? { deliver: options.deliver } : {}),
      render: options.render,
      platform: 'whatsapp',
      adapter: options.adapter,
      canStartThreads: false,
      // Each file goes as its own WhatsApp message: an image, video, audio, or document. WhatsApp can't delete them.
      async uploadFiles(thread, files) {
        const sent = await options.adapter.postMessage(thread, { markdown: '', files })
        return { message: sent.id, files: fileIds(sent.raw) }
      },
      // The adapter's answer for a file it can't send; WhatsApp's own refusals retry, then fail.
      refusesFiles: (error) => (error as { code?: string } | null)?.code === 'VALIDATION_ERROR',
      async resolveChannel(key) {
        if (!/^\d+$/.test(key)) throw new Error(`${key} isn't a phone number ID; use the number's ID from Kapso, not the number`)
        return key
      },
      fromChatId: decode,
      toChatId: encode,
      singleReaction: true,
      async startTyping(thread, latest) {
        if (!latest) return options.adapter.startTyping(thread)
        const [phoneNumberId] = decode(thread.slice(thread.indexOf(':') + 1)).split(':')
        await options.markRead({ phoneNumberId: phoneNumberId!, messageId: latest, typingIndicator: { type: 'text' } })
      },
      groupThread: (thread) => thread,
      isRoot: () => false,
      context: () => null,
      // Media comes over as attachments, through the adapter. A voice note may carry Kapso's transcript.
      markdown(message: ChatMessage) {
        const text = markdownOf(message)
        const transcript = (message.raw as Raw)?.kapso?.transcript?.text
        const heard = typeof transcript === 'string' && transcript.trim() && transcript !== text ? `> ${transcript.trim()}` : null
        return [text, heard].filter(Boolean).join('\n\n')
      },
      async resolveTarget(target): Promise<ResolvedTarget> {
        const parts = target.split(':')
        if (!/^\d+$/.test(parts[0]!) || (parts.length !== 1 && parts.length !== 3)) throw new Error(`invalid Kapso target: ${target}`)
        return { target, channel: parts[0]!, kind: parts.length === 1 ? 'channel' : 'thread' }
      },
    })
    for (const [key, value] of Object.entries(options.numbers)) this.map(key, value)
  }

  override eventId(key: string, input: ChatInput): string {
    if (input.kind !== 'reaction') return super.eventId(key, input)
    const reaction = input.reaction
    const stamp = z.looseObject({ id: z.string().min(1) }).parse(reaction.raw).id
    return `reaction:${key}:${this.toNative(reaction.threadId)}|${reaction.messageId}|${reaction.rawEmoji}|${reaction.user.userId}|${reaction.added}|${stamp}`
  }

  override event(context: Pick<SyncContext, 'id' | 'key' | 'event' | 'raw'>): WhatsAppEvent {
    return WhatsAppEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
