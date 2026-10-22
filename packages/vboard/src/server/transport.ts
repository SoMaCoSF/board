import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

/**
 * How a board POSTs to a URL a caller gave it: a wake-up to a board on `http()`. That URL
 * comes from a caller, so by default it's `https` to a public address only, checked as it
 * connects: no loopback, private, or link-local address, however its name resolves, and no
 * redirects. Tests pass their own.
 */
export type Post = (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>


/** Addresses a wake-up never reaches: this machine, private networks, link-local, and the rest that aren't the internet. */
const NOT_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  // IPv4-mapped addresses (`::ffff:127.0.0.1`) are checked against the IPv4 rules above.
  ['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6')

/** Whether `address` is one a wake-up may connect to. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  return family !== 0 && !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** Resolves as the system does, and refuses a name that resolves to any address that isn't public. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, found) => {
    if (error) return callback(error, '', 0)
    const addresses = found as unknown as LookupAddress[]
    const bad = addresses.find((entry) => !isPublicAddress(entry.address))
    if (bad || addresses.length === 0)
      return callback(Object.assign(new Error(`${hostname} resolves to ${bad?.address ?? 'nothing'}, which isn't a public address`), { code: 'ENOTPUBLIC' }), '', 0)
    if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses)
    callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

/** A response body is read only as far as an error message needs. */
const ERROR_BYTES = 4096

/** Statuses a `Response` has no body with. */
const NULL_BODY = new Set([204, 205, 304])

/**
 * A wake-up's answer as a `Response`, whatever status the other end chose: one with no body has
 * none, and one a `Response` can't have (outside 200 to 599) is a 502.
 */
function responseOf(status: number | undefined, body: Uint8Array<ArrayBuffer>): Response {
  if (status === undefined || !Number.isInteger(status) || status < 200 || status > 599) return new Response(null, { status: 502 })
  return new Response(NULL_BODY.has(status) ? null : body, { status })
}

/** POSTs to a public `https` URL: the default `Post`. */
export async function publicPost(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response> {
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error(`wake-ups go over https, not to ${url}`)
  const host = target.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) throw new Error(`${host} isn't a public address`)
  return new Promise<Response>((resolve, reject) => {
    const sent = httpsRequest(
      target,
      { method: 'POST', headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) }, lookup: publicLookup, signal: init.signal },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (size < ERROR_BYTES) chunks.push(chunk)
          size += chunk.length
        })
        // Nothing here may throw: it would escape the promise from a listener and take down the process.
        response.on('end', () => {
          try {
            resolve(responseOf(response.statusCode, Buffer.concat(chunks).subarray(0, ERROR_BYTES)))
          } catch (error) {
            reject(error)
          }
        })
        response.on('error', reject)
      },
    )
    sent.on('error', reject)
    sent.end(init.body)
  })
}
