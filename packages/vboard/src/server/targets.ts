import { extractMentions, replaceMentions } from '../contract/mentions.ts'
import { isThreadTarget, type Actor } from '../contract/reducers.ts'

/** A sync target, resolved: a platform channel to start a thread in, or a thread to join. */
export type SyncTarget = { target: string; kind: 'channel' | 'thread' }

/** A target as a post or a receipt names it, resolved: a plain one's kind goes by its shape. */
export const syncTarget = (target: string | SyncTarget): SyncTarget =>
  typeof target === 'string' ? { target, kind: isThreadTarget(target) ? 'thread' : 'channel' } : target

/** Whether `text` mentions anyone by email, `@[ada@vercel.com]`, which sync looks up. */
export const mentionsEmails = (text: string) => extractMentions(text).some((token) => token.kind === 'actor' && token.actor.includes('@'))

/**
 * `@[ada@vercel.com]`: each email `find` knows (a synced platform's user) becomes that user's
 * exact mention, `@[slack:user:U0456]`, so it reads natively there; the rest stay plain text.
 */
export async function withEmailMentions(text: string, find?: (email: string) => Promise<Actor | null>): Promise<{ text: string; found: Actor[] }> {
  const emails = extractMentions(text).flatMap((token) =>
    token.kind === 'actor' && token.actor.includes('@') ? [token.actor] : [],
  )
  if (emails.length === 0) return { text, found: [] }
  const byEmail = new Map<string, Actor | null>()
  for (const email of emails) byEmail.set(email, (await find?.(email).catch(() => null)) ?? null)
  return {
    text: replaceMentions(text, (token) => {
      if (token.kind !== 'actor' || !byEmail.has(token.actor)) return null
      const actor = byEmail.get(token.actor)
      return actor ? `@[${actor.id}]` : token.actor
    }),
    found: [...byEmail.values()].filter((actor) => actor !== null),
  }
}

