/**
 * What `vb grep` prints of one channel's messages, oldest first: the first `max` that match, and
 * the indexes to print, grouped so that `--` goes between groups. A group is a run of matches
 * whose `before` and `after` neighbours touch. One pass over the messages, so a channel of any
 * size costs the same per message.
 */
export function grepChannel<T>(messages: readonly T[], matches: (message: T) => boolean, { max, before, after }: { max: number; before: number; after: number }) {
  const hits: number[] = []
  for (let at = 0; at < messages.length && hits.length < max; at++) if (matches(messages[at]!)) hits.push(at)
  const groups: number[][] = []
  let end = -1
  for (const hit of hits) {
    if (!groups.length || hit - before > end + 1) groups.push([])
    const group = groups[groups.length - 1]!
    for (let at = Math.max(hit - before, end + 1); at <= Math.min(hit + after, messages.length - 1); at++) group.push(at)
    end = Math.max(end, Math.min(hit + after, messages.length - 1))
  }
  return { hits, groups }
}
