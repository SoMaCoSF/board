/**
 * gen-map.ts — regenerate class-layer/MAP.md from the live data dir.
 *
 * Every number in MAP.md is read from the run's own state at generation
 * time: the registry, the chain, the escrow file, and the board itself
 * (task states read through the handle). Nothing is typed in.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBoard, BOARD_NAME } from './board.ts'
import { loadChain, verifyChain } from './chain.ts'
import { loadEscrow } from './escrow.ts'
import { TYPE_NAMES, loadRegistry } from './identity.ts'
import { sinkState } from './supabase.ts'
import { dataDir } from './store.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = join(here, '..', 'MAP.md')
const short = (h: string) => h.slice(0, 12)

function ptNow(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

async function main(): Promise<void> {
  const identities = loadRegistry()
  const chain = loadChain()
  const escrow = loadEscrow()
  const verify = verifyChain()
  const byUuid = new Map(identities.map((i) => [i.uuid, i]))
  const nameOf = (uuid: string | null) => (uuid ? (byUuid.get(uuid)?.name ?? uuid) : '—')

  const { team, close } = openBoard()
  let taskRows: string[] = []
  let taskCount = 0
  const stateCounts: Record<string, number> = {}
  try {
    const page = await team.tasks.list({ state: 'all', latest: true, limit: 200 })
    taskCount = page.tasks.length
    taskRows = page.tasks.map((s) => {
      const t = s.message.task
      const state = t?.state ?? '—'
      stateCounts[state] = (stateCounts[state] ?? 0) + 1
      const identity = identities.find((i) => i.board?.taskId === s.message.id)
      const holder = t?.claim ? (byUuid.get('')?.name ?? t.claim.actor) : '—'
      return `| ${s.message.id} | ${s.message.channel} | ${s.message.text.replace(/\|/g, '/').slice(0, 70)} | ${state} | ${holder} | ${identity?.uuid ?? '—'} |`
    })
  } finally {
    await close()
  }

  const identityRows = identities.map(
    (i) =>
      `| ${i.name} | ${TYPE_NAMES[i.type_code]} | ${i.uuid} | ${i.ceiling.length ? i.ceiling.join(', ') : '—'} | ${short(i.profile_commitment)} |`,
  )

  const traceRows = chain.map((r) => {
    const p = r.payload as { taskUuid?: string | null; boardCursor?: string }
    const sink = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY ? 'local chain + Supabase receipts' : `local chain #${r.index}`
    return `| ${r.index} | ${r.action} | ${nameOf(r.actor_uuid)} | ${p.taskUuid ?? '—'} | ${r.uuid} | ${short(r.hash)} | ${p.boardCursor ?? '—'} | ${sink} |`
  })

  const escrowRows = escrow.holds.map(
    (h) => `| ${h.uuid} | ${h.task_uuid} | ${h.amount} test | ${h.state} | ${h.release_receipt_uuid ?? '—'} |`,
  )

  const md = `# The map — board event → task Identity → receipt → sink

Identity Is Infrastructure

Generated ${ptNow()} PT from the live data directory (${dataDir()}), read at
generation time: the Identity registry, the receipt chain, the escrow file,
and the board's own task list through the \`@vercel/board\` handle. Every
number below comes from that state.

All Identities on this board are PROVISIONAL — uuid5 placeholders derived
per \`class-layer/src/uuid.ts\`, pending the founder's mint rulings.
Sink state: ${sinkState()}.

## Identities

| name | type | uuid | ceiling | commitment |
| --- | --- | --- | --- | --- |
${identityRows.join('\n')}

## Tasks on board \`${BOARD_NAME}\`

${taskCount} tasks (${Object.entries(stateCounts)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ')}).

| board id | channel | title | state | claim holder (board actor id) | task uuid |
| --- | --- | --- | --- | --- | --- |
${taskRows.join('\n')}

## The trace

One row per receipt: the board event it mirrors (by board cursor, when the
receipt came from the board sync) or the class-layer act itself, the task
Identity it concerns, and where the receipt is stored.

| # | action | actor | task uuid | receipt uuid | hash (prefix) | board cursor | sink |
| --- | --- | --- | --- | --- | --- | --- | --- |
${traceRows.join('\n')}

## Escrow (test value)

| hold uuid | task uuid | amount | state | release receipt |
| --- | --- | --- | --- | --- |
${escrowRows.length ? escrowRows.join('\n') : '| — | — | — | — | — |'}

## Chain

${chain.length} receipts. Verify: ${verify.ok ? `OK — every link recomputes; head ${short(verify.headHash ?? '')}` : `BROKEN at index ${verify.brokenAt}: ${verify.reason}`}.
`
  writeFileSync(outPath, md)
  console.log(`MAP.md written  ${identities.length} identities  ${taskCount} tasks  ${chain.length} receipts  verify ${verify.ok ? 'OK' : 'BROKEN'}`)
}

await main()
