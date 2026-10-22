// `vboard` in Node: board() finds the board the environment points at, and can serve it: it
// verifies the OIDC tokens made out to it, and knows its own Vercel project.
import { http } from '../backend-http/index.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. With a `backend`, the board lives there: `a2()` keeps it in this
 * deployment, `http(url)` uses another. Without one, it's `http()` to the board the environment
 * points at: `VBOARD_URL`, then the repo's link (`vb link`, `vb serve`), then `vb use`'s.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, { http: () => http(), sync: () => import('../sync/engine.ts'), serving: () => import('./serving.ts') })
}

export * from './exports.ts'
