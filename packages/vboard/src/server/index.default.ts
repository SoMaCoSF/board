// `vboard` outside Node (a browser, say): board() on `http(url, { fetch })`, with nothing that
// needs Node. Serving requests, watchers, and sync need the `node` build.
import { http } from '../backend-http/index.default.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. Outside Node there's no environment to find one in, so pass its
 * backend: `board({ backend: http(url) })`, whose `fetch` sends the page's own session.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, { http: () => http(), serving: null, sync: null })
}

export * from './exports.ts'
