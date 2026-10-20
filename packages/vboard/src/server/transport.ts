import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { getVercelOidcToken } from '@vercel/oidc'

/** How a board reaches other boards: a board with a remote calls its remote, and a remote delivers to it. */
export type Transport = {
  fetch: typeof fetch
  /**
   * How a remote posts a match to the URL a board registered. That URL comes from a caller, so by
   * default it's `https` to a public address only, checked as it connects: no loopback, private,
   * or link-local address, however its name resolves, and no redirects.
   */
  deliver: (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>
  /** A token whose audience is `audience`, the URL it's sent to. */
  token: (audience: string) => Promise<string>
}

export function transport(options: Partial<Transport> = {}): Transport {
  const fetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  return {
    fetch,
    // A test that routes requests itself delivers through that too.
    deliver:
      options.deliver ??
      (options.fetch ? (url, init) => fetch(url, { method: 'POST', redirect: 'manual', ...init }) : publicPost),
    token: options.token ?? platformToken,
  }
}

/** The deployment's own OIDC token: on Vercel, the only way a board proves who it is to another. */
async function platformToken(audience: string): Promise<string> {
  if (process.env.VERCEL !== '1') throw new Error(`can't sign a request to ${audience}: only a board on Vercel can, with its OIDC token`)
  return getVercelOidcToken({ audience })
}

/** Addresses a delivery never reaches: this machine, private networks, link-local, and the rest that aren't the internet. */
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

/** Whether `address` is one a delivery may connect to. */
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

/** A delivery's response body is read only as far as an error message needs. */
const ERROR_BYTES = 4096

/** POSTs to a public `https` URL: the default `deliver`. */
async function publicPost(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response> {
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error(`deliveries go over https, not to ${url}`)
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
        response.on('end', () =>
          resolve(new Response(Buffer.concat(chunks).subarray(0, ERROR_BYTES), { status: response.statusCode ?? 502 })),
        )
        response.on('error', reject)
      },
    )
    sent.on('error', reject)
    sent.end(init.body)
  })
}
