/**
 * uuid.ts — identifier derivation for the class layer.
 *
 * PROVISIONAL derivation, stated plainly: every class-layer Identity is a
 * uuid5 (RFC 4122, SHA-1) over the standard DNS namespace
 * (6ba7b810-9dad-11d1-80b4-00c04fd430c8), keyed by a name string that says
 * what the thing is (`imbuuid:actor:<name>`, `imbuuid:task:<board>:<id>`,
 * `imbuuid:receipt:<index>:<hash>`). This follows the estate's established
 * uuid5(DNS, name) placeholder pattern. Production IMBUUID minting is gated
 * on the founder's mint rulings; until they land, these identifiers are
 * PROVISIONAL placeholders in that pattern — resolvable, typed, and
 * receipted, and labeled PROVISIONAL wherever they are shown.
 */
import { createHash } from 'node:crypto'

export const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function namespaceBytes(ns: string): Buffer {
  return Buffer.from(ns.replace(/-/g, ''), 'hex')
}

/** RFC 4122 uuid5: SHA-1 over namespace bytes + name, version/variant set. */
export function uuid5(name: string, namespace: string = DNS_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(namespaceBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** Canonical JSON: object keys sorted recursively, so hashes are stable. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}
