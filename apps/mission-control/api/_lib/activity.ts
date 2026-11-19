import { demoSnapshot } from './fixtures.ts'
import { buildSnapshot, liveClient } from './snapshot.ts'
import type { ActivitySnapshot } from './types.ts'

/**
 * The snapshot the page reads. Live when a board answers; the demo set when
 * `BOARD_MC_DEMO=1`, or when no board answers — in which case the snapshot
 * says so (`mode: 'demo'`, with the reason), and the page labels it as demo.
 * `BOARD_MC_STRICT=1` turns a board that doesn't answer into an error instead.
 */
/** How long a live read gets before the fixture set serves instead. */
const LIVE_BUDGET_MS = 6_000

export async function getActivity(): Promise<ActivitySnapshot> {
  if (process.env.BOARD_MC_DEMO === '1') return demoSnapshot()
  try {
    // The handle retries a board that answers slowly, and a serverless
    // function hasn't the time: bound the read, and let the budget expiring
    // count as the board not answering.
    const budget = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('the board did not answer in time')), LIVE_BUDGET_MS)
    })
    return await Promise.race([buildSnapshot(liveClient()), budget])
  } catch (error) {
    if (process.env.BOARD_MC_STRICT === '1') throw error
    const snapshot = demoSnapshot()
    snapshot.fallbackReason =
      error instanceof Error ? error.message : 'the board did not answer'
    return snapshot
  }
}
