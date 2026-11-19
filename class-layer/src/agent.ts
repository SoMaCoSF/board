/**
 * agent.ts — board-agent: the estate agent's one-call interface to the
 * class layer. Each command does the board act and its receipt together:
 *
 *   register <name> --ceiling READ,WRITE,...   an imbuuid@1 Identity
 *   channel <name> [--as actor]               create a channel (first post would too)
 *   post <channel> <title> [--as actor]        a task on the board + its Identity
 *   claim <taskId> [--as actor]                claim-with-lease, receipted
 *   complete <taskId> [--as actor] [--result]  settle, receipted; an open
 *                                              escrow hold releases against
 *                                              the verified completion
 *   fail <taskId> [--as actor] [--reason]      give up a claimed task
 *   step <CLASS> [--as actor] [--note]         one ceiling-gated act; a
 *                                              refusal is receipted
 *   route <taskId> --class X --candidates a,b  a decision@1 routing receipt
 *                                              (local tier; backend named)
 *   escrow hold <taskId> <amount> [--as]       test value under the task
 *   sync                                       mirror board events to receipts
 *   verify                                     recompute the receipt chain
 *   state                                      registry + chain summary
 *
 * Exit codes: 0 ok · 1 error · 3 ceiling refusal (the refusal is receipted).
 */
import { appendReceipt, loadChain, verifyChain } from './chain.ts'
import { holdEscrow, openHoldFor, releaseEscrow } from './escrow.ts'
import { CeilingRefused, gate } from './gate.ts'
import {
  ACTION_CLASSES,
  TYPE_NAMES,
  findByName,
  findTaskByBoardId,
  loadRegistry,
  registerActor,
  registerTask,
} from './identity.ts'
import { asActor, openBoard, BOARD_NAME } from './board.ts'
import { syncBoard } from './sync.ts'
import { readJson, writeJson } from './store.ts'
import { sinkState } from './supabase.ts'

interface ClaimRecord {
  actor: string
  epoch: number
  token: string
  until: string
}

const CLAIMS = 'claims.json'

function loadClaims(): Record<string, ClaimRecord> {
  return readJson<Record<string, ClaimRecord>>(CLAIMS, {})
}

function saveClaims(claims: Record<string, ClaimRecord>): void {
  writeJson(CLAIMS, claims)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function withoutFlags(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++ // skip its value
      continue
    }
    out.push(args[i])
  }
  return out
}

const short = (h: string) => h.slice(0, 12)

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const as = flag(rest, 'as') ?? 'witness'
  try {
    switch (cmd) {
      case 'register': {
        const [name] = withoutFlags(rest)
        const ceiling = (flag(rest, 'ceiling') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!name || ceiling.length === 0) throw new Error('usage: register <name> --ceiling READ,WRITE,...')
        const { identity, created } = await registerActor(name, ceiling)
        if (created) {
          await appendReceipt(identity.uuid, 'identity.registered', {
            actor: name,
            type: 'actor',
            ceiling: identity.ceiling,
            profile_commitment: identity.profile_commitment,
            provisional: true,
          })
        }
        console.log(`identity ${name}  uuid ${identity.uuid}  ceiling [${identity.ceiling.join(', ')}]${created ? '' : '  (already registered)'}`)
        return 0
      }

      case 'channel': {
        const [name] = withoutFlags(rest)
        if (!name) throw new Error('usage: channel <name> [--as actor]')
        await gate(as, 'WRITE', { channel: name })
        const { team, close } = openBoard()
        try {
          const { created } = await asActor(team, as).createChannel(name)
          console.log(`channel ${name}  ${created ? 'created' : 'already there'}`)
          return 0
        } finally {
          await close()
        }
      }

      case 'post': {
        const [channel, ...titleParts] = withoutFlags(rest)
        const title = titleParts.join(' ')
        if (!channel || !title) throw new Error('usage: post <channel> <title...> [--as actor]')
        const actor = await gate(as, 'WRITE', { channel, title })
        const { team, close } = openBoard()
        try {
          const labels: Record<string, string> = {}
          for (const pair of (flag(rest, 'labels') ?? '').split(',').filter(Boolean)) {
            const [k, v] = pair.split('=')
            if (k && v) labels[k] = v
          }
          const { task } = await asActor(team, as).tasks.create(channel, { text: title, labels })
          const taskIdentity = await registerTask(BOARD_NAME, task.id, channel, title)
          const sync = await syncBoard(team)
          console.log(`task ${task.id}  channel ${channel}  uuid ${taskIdentity.uuid}`)
          console.log(`posted by ${actor.name}  receipts +${sync.receiptsAppended}`)
          return 0
        } finally {
          await close()
        }
      }

      case 'claim': {
        const [taskId] = withoutFlags(rest)
        if (!taskId) throw new Error('usage: claim <taskId> [--as actor]')
        await gate(as, 'CLAIM', { boardTaskId: taskId })
        const { team, close } = openBoard()
        try {
          const claim = await asActor(team, as).tasks.claim(taskId)
          const claims = loadClaims()
          claims[taskId] = { actor: as, epoch: claim.epoch, token: claim.token, until: claim.until }
          saveClaims(claims)
          const sync = await syncBoard(team)
          console.log(`claimed ${taskId} by ${as}  lease until ${claim.until}  receipts +${sync.receiptsAppended}`)
          return 0
        } finally {
          await close()
        }
      }

      case 'complete': {
        const [taskId] = withoutFlags(rest)
        if (!taskId) throw new Error('usage: complete <taskId> [--as actor] [--result "..."]')
        const result = flag(rest, 'result') ?? 'completed'
        await gate(as, 'COMPLETE', { boardTaskId: taskId })
        const claims = loadClaims()
        const held = claims[taskId]
        if (!held) throw new Error(`no open claim on ${taskId} in this data dir (claim it first)`)
        if (held.actor !== as) throw new Error(`task ${taskId} is claimed by ${held.actor}, not ${as}`)
        const { team, close } = openBoard()
        try {
          await asActor(team, as).tasks.held(taskId, { epoch: held.epoch, token: held.token }).complete(result)
          delete claims[taskId]
          saveClaims(claims)
          const sync = await syncBoard(team)
          console.log(`completed ${taskId} by ${as}  receipts +${sync.receiptsAppended}`)
          const taskIdentity = findTaskByBoardId(BOARD_NAME, taskId)
          if (taskIdentity && openHoldFor(taskIdentity.uuid)) {
            const completer = findByName(as)
            if (completer) {
              const released = await releaseEscrow(completer.uuid, as, taskIdentity.uuid, taskId)
              console.log(`escrow released  ${released.amount} test  hold ${released.uuid}  against the verified completion receipt`)
            }
          }
          return 0
        } finally {
          await close()
        }
      }

      case 'fail': {
        const [taskId] = withoutFlags(rest)
        if (!taskId) throw new Error('usage: fail <taskId> [--as actor] [--reason "..."]')
        const reason = flag(rest, 'reason') ?? 'failed'
        const claims = loadClaims()
        const held = claims[taskId]
        if (!held || held.actor !== as) throw new Error(`no open claim on ${taskId} held by ${as}`)
        const { team, close } = openBoard()
        try {
          await asActor(team, as).tasks.held(taskId, { epoch: held.epoch, token: held.token }).fail(reason)
          delete claims[taskId]
          saveClaims(claims)
          const sync = await syncBoard(team)
          console.log(`failed ${taskId} by ${as}  receipts +${sync.receiptsAppended}`)
          return 0
        } finally {
          await close()
        }
      }

      case 'step': {
        const [cls] = withoutFlags(rest)
        if (!cls || !(ACTION_CLASSES as readonly string[]).includes(cls.toUpperCase())) {
          throw new Error(`usage: step <${ACTION_CLASSES.join('|')}> [--as actor] [--note "..."]`)
        }
        const actor = await gate(as, cls, { note: flag(rest, 'note') ?? null })
        const receipt = await appendReceipt(actor.uuid, `step.${cls.toLowerCase()}`, {
          actor: as,
          note: flag(rest, 'note') ?? null,
        })
        console.log(`step ${cls.toUpperCase()} by ${as}  receipt ${receipt.uuid}  hash ${short(receipt.hash)}`)
        return 0
      }

      case 'route': {
        const [taskId] = withoutFlags(rest)
        const taskClass = (flag(rest, 'class') ?? 'WRITE').toUpperCase()
        const candidates = (flag(rest, 'candidates') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!taskId || candidates.length === 0) throw new Error('usage: route <taskId> --class WRITE --candidates a,b [--as witness]')
        const router = await gate(as, 'ROUTE', { boardTaskId: taskId })
        const taskIdentity = findTaskByBoardId(BOARD_NAME, taskId)
        const eligible = candidates.filter((name) => {
          const c = findByName(name)
          return c ? c.ceiling.includes(taskClass) : false
        })
        const choice = eligible[0] ?? null
        const distribution: Record<string, number> = {}
        for (const name of eligible) distribution[name] = eligible.length ? 1 / eligible.length : 0
        const receipt = await appendReceipt(router.uuid, 'decision.routed', {
          actor: as,
          taskUuid: taskIdentity?.uuid ?? null,
          boardTaskId: taskId,
          taskClass,
          candidates,
          eligible,
          choice,
          // Local tier rule (fold-in C2): confidence is stated as the
          // probability of the chosen answer — here uniform over the
          // candidates whose ceilings admit the task's class.
          confidence: choice ? (distribution[choice] ?? 0) : 0,
          distribution,
          backend: 'localjev-local-tier',
          blocked: choice ? null : 'awaiting_approval',
        })
        console.log(`route ${taskId}  class ${taskClass}  choice ${choice ?? 'none — blocked awaiting_approval'}  confidence ${receipt.payload.confidence}  backend localjev-local-tier`)
        return 0
      }

      case 'escrow': {
        const [sub, taskId, amountRaw] = withoutFlags(rest)
        if (sub !== 'hold' || !taskId || !amountRaw) throw new Error('usage: escrow hold <taskId> <amount> [--as actor]')
        const amount = Number(amountRaw)
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number (test value)')
        const actor = await gate(as, 'ESCROW', { boardTaskId: taskId })
        const taskIdentity = findTaskByBoardId(BOARD_NAME, taskId)
        if (!taskIdentity) throw new Error(`task ${taskId} has no Identity in this registry (post it through board-agent first)`)
        const hold = await holdEscrow(actor.uuid, as, taskIdentity.uuid, taskId, amount)
        console.log(`escrow held  ${amount} test  under task ${taskId} (${taskIdentity.uuid})  hold ${hold.uuid}`)
        return 0
      }

      case 'sync': {
        const { team, close } = openBoard()
        try {
          const sync = await syncBoard(team)
          console.log(`sync  events ${sync.eventsSeen}  receipts +${sync.receiptsAppended}  cursor ${sync.lastCursor ?? 'none'}`)
          return 0
        } finally {
          await close()
        }
      }

      case 'verify': {
        const v = verifyChain()
        if (v.ok) {
          console.log(`chain OK  ${v.length} receipts  head ${short(v.headHash ?? '')}`)
          return 0
        }
        console.log(`chain BROKEN at index ${v.brokenAt}: ${v.reason}  (${v.length} receipts)`)
        return 1
      }

      case 'state': {
        const identities = loadRegistry()
        const chain = loadChain()
        console.log(`board  ${BOARD_NAME}  sink  ${sinkState()}`)
        for (const i of identities) {
          console.log(`identity  ${i.name}  ${TYPE_NAMES[i.type_code]}  ${i.uuid}  ceiling [${i.ceiling.join(', ')}]`)
        }
        console.log(`chain  ${chain.length} receipts  head ${chain.length ? short(chain[chain.length - 1].hash) : 'none'}`)
        return 0
      }

      default:
        console.log('board-agent — register | channel | post | claim | complete | fail | step | route | escrow hold | sync | verify | state')
        console.log('run with no command for this list; see class-layer/USAGE.md')
        return cmd ? 1 : 0
    }
  } catch (err) {
    if (err instanceof CeilingRefused) {
      console.error(`refused  ${err.message}  refusal receipt ${err.receiptUuid}`)
      return 3
    }
    console.error(`error  ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
