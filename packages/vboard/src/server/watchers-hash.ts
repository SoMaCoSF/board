export type WatcherSpec = { tail: string; when: 'matches' | 'enters' }
/** A registrant's sync entry: what it imports through, and whether it signs people in. */
export type SyncEntrySpec = { key: string; platform: string; signIn: boolean }

/**
 * What `watchersHash` hashes, the same on both ends: a board on `http()` hashes its watchers, and
 * whether its sync subscribes, and the board it uses hashes what it holds.
 */
export function canonicalWatchers(watch: Record<string, WatcherSpec>, sync: readonly SyncEntrySpec[] = []): string {
  const canonical: unknown[] = Object.keys(watch)
    .sort()
    .map((id) => [id, watch[id]!.tail, watch[id]!.when])
  // Older registrations hashed only their watchers: one with no sync hashes as it did.
  if (sync.length > 0) canonical.push(['sync', [...sync].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => [entry.key, entry.platform, entry.signIn])])
  return JSON.stringify(canonical)
}
