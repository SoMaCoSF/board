import { createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK } from 'jose'
import { duration } from '../client/client.ts'
import type { TokenView } from '../api/routes.ts'
import type { Protocol } from '../api/protocol.ts'
import { parseScope } from './access.ts'
import { isAvatarUrl } from './actors.ts'
import type { Principal, PrincipalKind, TokenFacts } from './auth.ts'
import type { Identity } from './backend.ts'
import { DELEGATE_TTL_DEFAULT_S, DELEGATE_TTL_MAX_S, DELEGATE_TYP, normalizeScope } from './delegate.ts'
import { badRequest, forbidden, HttpError, unauthorized } from './errors.ts'

// Signing and verifying delegate tokens, with jose: loaded only where a board keeps its log.

const ALG = 'EdDSA'

/** The key a backend signs delegate tokens with, and its public half to publish. */
export type SigningKey = { kid: string; privateJwk: JWK; publicJwk: JWK }

/** A new Ed25519 signing key, its halves exported, for a backend to keep. */
export async function newSigningKey(): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true })
  const kid = crypto.randomUUID()
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: ALG, use: 'sig' }
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: ALG }
  return { kid, privateJwk, publicJwk }
}

/**
 * The token `identity` asked for, signed with `key`: the board's URL is its issuer and audience,
 * its subject the caller's principal. A 403 for a narrowed caller, a 400 for a body that doesn't
 * hold up.
 */
export async function mintDelegate(identity: Identity, input: Protocol['token']['input'], key: SigningKey): Promise<TokenView> {
  const { principal, author, actor } = identity
  if (principal.scope !== undefined)
    throw forbidden(principal.delegate ? "a delegate token can't mint another token" : "this token is narrowed with x-board-scope, so it can't mint tokens")
  if (input.avatar !== undefined && !isAvatarUrl(input.avatar)) throw badRequest('avatars must be https URLs (http only on localhost)')
  let scope = '*=all'
  if (input.scope !== undefined) {
    scope = normalizeScope(input.scope)
    try {
      parseScope(scope)
    } catch (error) {
      throw badRequest((error as Error).message.replace(/x-board-scope/g, 'scope'), 'invalid_scope')
    }
  }
  const asked = input.ttl === undefined ? DELEGATE_TTL_DEFAULT_S : Math.floor(duration(input.ttl) / 1000)
  if (asked <= 0) throw badRequest('ttl must be longer than a second')
  const now = Math.floor(Date.now() / 1000)
  let exp = now + Math.min(asked, DELEGATE_TTL_MAX_S)
  // It never outlives the token that minted it.
  if (principal.expiresAt !== null) exp = Math.min(exp, Math.floor(principal.expiresAt.getTime() / 1000))
  if (exp <= now) throw unauthorized('token expired')
  const profile = input.profile ?? author.profile
  // A person's handle is what their CLI sent, as the board resolved it for this request.
  const base = author.profile === null ? actor.handle : actor.handle.slice(0, actor.handle.length - author.profile.length - 1)
  const claims = {
    board: {
      kind: principal.kind,
      handle: base,
      ...(principal.facts ? { facts: principal.facts } : {}),
      scope,
      profile,
      avatar: input.avatar ?? (input.profile === undefined ? (identity.actor.avatar ?? null) : null),
      session: input.session ?? author.session,
      name: profile === null && principal.kind === 'person' ? actor.name : null,
    },
  }
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid: key.kid, typ: DELEGATE_TYP })
    .setIssuer(input.audience)
    .setAudience(input.audience)
    .setSubject(principal.id)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(await importJWK(key.privateJwk, ALG))
  return { token, expiresAt: new Date(exp * 1000).toISOString(), can: principal.access.narrow(parseScope(scope)).summary() }
}

const KINDS: readonly PrincipalKind[] = ['person', 'deployment', 'workflow', 'external']
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/** Who a delegate token is, verified with the board's published keys for its URL: a 401 when it fails. */
export async function verifyDelegate(token: string, audience: string, keys: Record<string, unknown>[]): Promise<Principal> {
  let payload: Record<string, unknown>
  try {
    ;({ payload } = await jwtVerify(token, createLocalJWKSet({ keys: keys as JWK[] }), { issuer: audience, audience, typ: DELEGATE_TYP, algorithms: [ALG] }))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw unauthorized(`invalid token: ${(error as Error).message}`)
  }
  const board = payload.board as Record<string, unknown> | undefined
  const sub = text(payload.sub)
  const jti = text(payload.jti)
  if (!board || sub === null || jti === null || !KINDS.includes(board.kind as PrincipalKind) || typeof board.scope !== 'string' || typeof board.handle !== 'string')
    throw unauthorized('invalid token: not a delegate token')
  const exp = typeof payload.exp === 'number' ? payload.exp : null
  return {
    id: sub,
    kind: board.kind as PrincipalKind,
    handle: board.handle,
    expiresAt: exp === null ? null : new Date(exp * 1000),
    ...(board.facts ? { facts: board.facts as TokenFacts } : {}),
    scope: board.scope,
    delegate: { profile: text(board.profile), avatar: text(board.avatar), session: text(board.session), name: text(board.name), jti },
  }
}

