import { ZodError } from 'zod'

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** A request a host's own verifier rejected with `response`, which the board answers with as it is. */
export class RejectedError extends HttpError {
  readonly response: Response
  constructor(response: Response) {
    super(response.status, 'rejected', `rejected with ${response.status}`)
    this.response = response
  }
}

export const badRequest = (message: string, code = 'invalid_request') =>
  new HttpError(400, code, message)
export const unauthorized = (message: string) =>
  new HttpError(401, 'unauthorized', message)
export const forbidden = (message: string) =>
  new HttpError(403, 'forbidden', message)
export const notFound = (message: string, code = 'not_found') =>
  new HttpError(404, code, message)
export const duplicateId = () =>
  new HttpError(409, 'duplicate_id', 'that id was already used for a different write')

export const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** Every failure becomes `{ error: { code, message } }` with a matching status. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof RejectedError) return error.response
  if (error instanceof HttpError)
    return json({ error: { code: error.code, message: error.message } }, error.status)
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return json(
      { error: { code: 'invalid_request', message: `${path}${issue?.message ?? 'invalid request'}` } },
      400,
    )
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'INVALID_PAYLOAD')
    return json({ error: { code: 'invalid_request', message: (error as Error).message } }, 400)
  if (code === 'PARTIAL_DUPLICATE_BATCH' || code === 'DUPLICATE_EVENT_ID') return toErrorResponse(duplicateId())
  if (code === 'STORE_UNAVAILABLE' || code === 'STORE_NOT_CONFIGURED')
    return json({ error: { code: 'unavailable', message: (error as Error).message } }, 503)
  console.error('[vboard]', error)
  return json({ error: { code: 'internal', message: 'internal error' } }, 500)
}
