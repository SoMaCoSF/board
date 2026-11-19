/**
 * worked-example.ts — the proposal's worked example as a scripted test.
 *
 * The run from the IMBUUID-in-Jevie explainer (SOM-DOC-10866), executed
 * against a throwaway data dir: a mail-sort pack loads under a ceiling of
 * READ + CLASSIFY; step 1 reads the inbox, step 2 files the receipts,
 * step 3 attempts SEND — the registry check stops it, and the refusal is
 * receipted. The chain then verifies; a forged line appended after the
 * fact is detected at its index.
 *
 * Run: npm test   (or: node test/worked-example.ts)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BOARD_ESTATE_DIR = mkdtempSync(join(tmpdir(), 'board-estate-test-'))

const { appendReceipt, loadChain, verifyChain } = await import('../src/chain.ts')
const { CeilingRefused, gate } = await import('../src/gate.ts')
const { registerActor } = await import('../src/identity.ts')
const { appendLine } = await import('../src/store.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

// The pack loads: an Identity with ceiling READ + CLASSIFY.
const { identity: pack } = await registerActor('mail-sort-pack', ['READ', 'CLASSIFY'])
await appendReceipt(pack.uuid, 'identity.registered', { actor: pack.name, ceiling: pack.ceiling, provisional: true })
check('pack registered under READ + CLASSIFY', pack.ceiling.join(',') === 'CLASSIFY,READ')

// Step 1 — sort my inbox: READ is inside the ceiling.
await gate('mail-sort-pack', 'READ')
await appendReceipt(pack.uuid, 'step.read', { step: 1, note: 'sort my inbox; read the inbox' })
check('step 1 READ executed', true)

// Step 2 — file the receipts: CLASSIFY is inside the ceiling.
await gate('mail-sort-pack', 'CLASSIFY')
await appendReceipt(pack.uuid, 'step.classify', { step: 2, note: 'file the receipts' })
check('step 2 CLASSIFY executed', true)

// Step 3 — SEND: outside the ceiling. The act does not execute; the
// refusal is receipted with the clause named.
let refused: InstanceType<typeof CeilingRefused> | undefined
try {
  await gate('mail-sort-pack', 'SEND', { step: 3, note: 'send nothing — the pack holds no SEND right' })
} catch (err) {
  if (err instanceof CeilingRefused) refused = err
}
check('step 3 SEND refused at the gate', refused !== undefined)
const refusal = loadChain().find((r) => r.action === 'ceiling.refused')
check(
  'refusal is on the chain, clause named',
  refusal !== undefined && refusal.payload.attempted === 'SEND' && String(refusal.payload.clause).includes('SEND'),
  refusal ? `receipt ${refusal.uuid}` : '',
)
check('no SEND step executed', !loadChain().some((r) => r.action === 'step.send'))

// The chain verifies end to end.
const v = verifyChain()
check('chain verifies', v.ok && v.length === loadChain().length, `${v.length} receipts`)

// A forged line appended after the fact is detected at its index.
const forged = { ...loadChain()[loadChain().length - 1], payload: { forged: true } }
appendLine('chain.jsonl', JSON.stringify(forged))
const v2 = verifyChain()
check('tamper detected', !v2.ok, v2.ok ? '' : `broken at index ${v2.brokenAt}: ${v2.reason}`)

console.log(failures === 0 ? 'worked example: all checks pass' : `worked example: ${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
