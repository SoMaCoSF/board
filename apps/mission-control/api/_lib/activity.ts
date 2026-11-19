import { demoSnapshot } from './fixtures.ts'
import { buildSnapshot, liveClient } from './snapshot.ts'
import type { ActivitySnapshot } from './types.ts'

/**
 * The snapshot the page reads. Live when a board answers; the demo set when
 * `BOARD_MC_DEMO=1`, or when no board answers — in which case the snapshot
 * says so (`mode: 'demo'`, with the reason), and the page labels it as demo.
 * `BOARD_MC_STRICT=1` turns a board that doesn't answer into an error instead.
 */
export async function getActivity(): Promise<ActivitySnapshot> {
  if (process.env.BOARD_MC_DEMO === '1') return demoSnapshot()
  try {
    return await buildSnapshot(liveClient())
  } catch (error) {
    if (process.env.BOARD_MC_STRICT === '1') throw error
    const snapshot = demoSnapshot()
    snapshot.fallbackReason =
      error instanceof Error ? error.message : 'the board did not answer'
    return snapshot
  }
}
