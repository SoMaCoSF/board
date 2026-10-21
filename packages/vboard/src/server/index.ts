// `vboard` in Node: board() finds the board the environment points at, and can serve it.
import { http } from '../backend-http/index.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. With a `backend`, the board lives there: `a2()` keeps it in this
 * deployment, `http(url)` uses another. Without one, it's `http()` to the board the environment
 * points at: `VBOARD_URL`, then the repo's link (`vb link`, `vb serve`), then `vb use`'s.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, { http: () => http(), serving: () => import('./serving.ts'), sync: () => import('../sync/engine.ts') })
}

export * from './exports.ts'
