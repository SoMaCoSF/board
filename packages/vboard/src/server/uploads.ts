import { reducer } from 'experimental-a2'
import { createServer, type A2Store } from 'experimental-a2/server'
import { uploadsContract } from '../contract/contract.ts'
import { HttpError } from './errors.ts'

/** Bytes each principal may upload a UTC day, unless `board({ uploadQuota })` says otherwise. */
export const UPLOAD_QUOTA = 1024 ** 3
/** A file counts as at least this, so a quota can't become millions of tiny objects. */
const MIN_CHARGE = 64 * 1024

const quotaReducer = reducer({
  contract: uploadsContract,
  name: 'vboard.upload-quota.v1',
  initialState: { used: 0, refused: [] as number[] },
}).fold((state, event) => {
  const { bytes, quota } = event.payload
  if (state.used + bytes <= quota) state.used += bytes
  else state.refused.push(event.index)
  return state
})

/** Charges an upload of `size` bytes to `principal`'s quota for today, or refuses it. */
export function uploadCharger(options: { store?: A2Store | undefined; quota: number }) {
  const server = createServer({ contract: uploadsContract, ...(options.store ? { store: options.store } : {}) })
  const refused = () => new HttpError(429, 'upload_quota', 'this token has used its upload quota for today (UTC): try again tomorrow')
  return async (principal: string, size: number) => {
    const bytes = Math.max(size, MIN_CHARGE)
    const session = server.session(`uploads:${principal}:${new Date().toISOString().slice(0, 10)}`)
    if ((await session.state(quotaReducer)).state.used + bytes > options.quota) throw refused()
    const [charged] = await session.append({ type: 'upload.charged', payload: { bytes, quota: options.quota } })
    // Uploads at once can all pass the check above; the log's order decides which fit.
    if ((await session.state(quotaReducer)).state.refused.includes(charged!.index)) throw refused()
  }
}
