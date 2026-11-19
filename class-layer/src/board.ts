/**
 * board.ts — open the estate board: the repo's own @vercel/board on its
 * local backend, in the class layer's data directory. One board, named
 * `estate`; its SQLite file lives at <data dir>/board/estate.db.
 */
import { board, type Board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { boardDir } from './store.ts'

export const BOARD_NAME = 'estate'

export interface OpenBoard {
  team: Board
  close: () => Promise<void>
}

export function openBoard(): OpenBoard {
  const backend = local({ dir: boardDir() })
  const team = board({ backend, name: BOARD_NAME })
  return { team, close: () => backend.close() }
}

/** The handle that writes as one actor (a Board profile of the same name). */
export function asActor(team: Board, actorName: string): Board {
  return team.as(actorName)
}
