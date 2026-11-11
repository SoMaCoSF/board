type Message = { readonly id: string; readonly text: string }

type Options = {
  /** Stop after this many matches, across channels. */
  max: number
  /** How many messages to show before and after each match (`-B`, `-A`). */
  before: number
  after: number
  /** `-c`: a `channel:N` row a channel; `-l`: a row for each channel with a match. */
  only?: 'count' | 'channels'
  /** How a row shows a message's ID. */
  ref: (id: string) => string
}

/**
 * `vb grep` over messages already read, by channel, each oldest first: the messages that match,
 * for `--json`, and the rows to print. A match is `channel:id:line`, the first line that matched;
 * context is `channel-id-line`, the message's first line; `--` goes between groups. One pass over
 * each channel, so a channel of any size costs the same per message.
 */
export function grep<M extends Message>(channels: ReadonlyMap<string, readonly M[]>, regex: RegExp, { max, before, after, only, ref }: Options) {
  const line = (message: M) => message.text.split(/\r?\n/).find((text) => regex.test(text))
  const matches: M[] = []
  const rows: string[] = []
  for (const [channel, messages] of channels) {
    const hits = new Set<number>()
    for (let at = 0; at < messages.length && matches.length < max; at++)
      if (line(messages[at]!) !== undefined) hits.add(at), matches.push(messages[at]!)
    if (only === 'count') rows.push(`${channel}:${hits.size}`)
    if (only === 'channels' && hits.size) rows.push(channel)
    if (only) continue
    // Each match adds its context once, from past the last message already shown.
    let end = -1
    for (const hit of hits) {
      if ((before || after) && rows.length && (end < 0 || hit - before > end + 1)) rows.push('--')
      for (let at = Math.max(hit - before, end + 1); at <= Math.min(hit + after, messages.length - 1); at++) {
        const message = messages[at]!
        const mark = hits.has(at) ? ':' : '-'
        rows.push(`${channel}${mark}${ref(message.id)}${mark}${(hits.has(at) ? line(message) : message.text.split(/\r?\n/)[0]) ?? ''}`)
      }
      end = Math.max(end, Math.min(hit + after, messages.length - 1))
    }
  }
  return { matches, rows }
}
