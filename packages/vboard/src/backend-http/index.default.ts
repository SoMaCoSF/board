// `vboard/backend-http` outside Node: the board at `url`, through the `fetch` you give it.
import { createHttp, type HttpBackend, type HttpOptions } from '../server/backend-http.ts'

/**
 * The board at `url`, which keeps the log. Outside Node there's no environment to find it or a
 * token in: `fetch` (the global one by default) sends the page's own session, which the board's
 * `authenticate` recognizes.
 */
export function http(url?: string, options: HttpOptions = {}): HttpBackend {
  return createHttp(url, options, null)
}

export type { HttpBackend, HttpOptions }
