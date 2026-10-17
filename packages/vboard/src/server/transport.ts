import { getVercelOidcToken } from '@vercel/oidc'

/** How a board reaches other boards: a board with a remote calls its remote, and a remote delivers to it. */
export type Transport = {
  fetch: typeof fetch
  /** A token whose audience is `audience`, the URL it's sent to. */
  token: (audience: string) => Promise<string>
}

export function transport(options: Partial<Transport> = {}): Transport {
  return {
    fetch: options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)),
    token: options.token ?? platformToken,
  }
}

/** The deployment's own OIDC token: on Vercel, the only way a board proves who it is to another. */
async function platformToken(audience: string): Promise<string> {
  if (process.env.VERCEL !== '1') throw new Error(`can't sign a request to ${audience}: only a board on Vercel can, with its OIDC token`)
  return getVercelOidcToken({ audience })
}
