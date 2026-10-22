// `vboard` outside Node (a browser, say): board() with nothing that needs Node. It finds no board,
// credentials, or project in the environment, and verifies no tokens by itself, so pass its backend
// (and to serve requests, `authenticate` and `project`); everything else runs as it does in Node.
import { http } from '../backend-http/index.default.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. Outside Node there's no environment to find one in, so pass its
 * backend: `board({ backend: http(url) })`, whose `fetch` sends the page's own session.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, { http: () => http(), sync: () => import('../sync/engine.ts'), serving: null })
}

export * from './exports.ts'
