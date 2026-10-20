import { get, put } from '@vercel/blob'
import type { BlobStore } from '../server/blob.ts'

/**
 * Attachments in a private Vercel Blob store. Connect one to the board's
 * project; the SDK finds it through `BLOB_READ_WRITE_TOKEN`, or the project's
 * OIDC token and `BLOB_STORE_ID`. Files are private: the board serves them to
 * callers it verified, and the store never hands them out.
 */
export function vercelBlob(options: { token?: string; storeId?: string; prefix?: string } = {}): BlobStore {
  const auth = { ...(options.token ? { token: options.token } : {}), ...(options.storeId ? { storeId: options.storeId } : {}) }
  // `prefix`: one store for many boards, each under its own path, so no board serves another's files.
  const prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  return {
    async put(key, data, contentType) {
      await put(prefix + key, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
        ...auth,
        access: 'private',
        contentType,
        addRandomSuffix: false,
      })
    },
    async get(key) {
      const found = await get(prefix + key, { ...auth, access: 'private' })
      if (!found || found.statusCode !== 200) return null
      return { data: found.stream, contentType: found.blob.contentType }
    },
  }
}
