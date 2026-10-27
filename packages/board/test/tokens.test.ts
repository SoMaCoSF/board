import { decodeJwt, decodeProtectedHeader, SignJWT, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { vercelProject } from '../src/access/index.ts'
import { BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'

/** A board the marketing project's deployments may use fully, as the factory's is. */
const factoryBoard = () => testBoard({ access: [vercelProject({ project: 'prj_marketing', can: 'all' })] })

/** A delegate token, minted over HTTP with `token`. */
async function mint(fetch: (request: Request) => Promise<Response>, token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { status, body: minted } = await caller(fetch, token, headers)('POST', '/tokens', body)
  expect(status, JSON.stringify(minted)).toBe(201)
  return minted as { token: string; expiresAt: string; can: Record<string, string[]> }
}

describe('delegate tokens', () => {
  it('write as the minter, with the profile, avatar, and session the board signed', async () => {
    const { fetch } = factoryBoard()
    const minted = await mint(fetch, await deploymentToken(), {
      profile: 'clever-lemur-1956',
      avatar: 'https://example.com/lemur.png',
      session: 'thread-1956',
      scope: 'dev=read,post',
    })
    expect(decodeProtectedHeader(minted.token)).toMatchObject({ alg: 'EdDSA', typ: 'board-delegate+jwt' })
    expect(decodeJwt(minted.token)).toMatchObject({ iss: BOARD_URL, aud: BOARD_URL, sub: 'vercel:project:prj_marketing:production' })

    const agent = caller(fetch, minted.token)
    const me = await agent('GET', '/me')
    expect(me.body).toMatchObject({
      actor: 'vercel:project:prj_marketing:production+clever-lemur-1956',
      principal: 'vercel:project:prj_marketing:production',
      profile: 'clever-lemur-1956',
      session: 'thread-1956',
      avatar: 'https://example.com/lemur.png',
      can: { dev: ['read', 'post'] },
    })
    const posted = await agent('POST', '/messages', { channel: 'dev', text: 'on it' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by).toEqual({
      actor: 'vercel:project:prj_marketing:production+clever-lemur-1956',
      principal: 'vercel:project:prj_marketing:production',
      profile: 'clever-lemur-1956',
      session: 'thread-1956',
    })
  })

  it('refuse headers that name another profile or session, and take the same ones', async () => {
    const { fetch } = factoryBoard()
    const { token } = await mint(fetch, await deploymentToken(), { profile: 'lemur', session: 'thread-1' })
    const as = (headers: Record<string, string>) => caller(fetch, token, headers)('GET', '/me')
    expect(await as({ 'x-board-profile': 'someone-else' })).toMatchObject({ status: 400, body: { error: { code: 'delegate_profile' } } })
    expect(await as({ 'x-board-session': 'thread-2' })).toMatchObject({ status: 400, body: { error: { code: 'delegate_session' } } })
    expect(await as({ 'x-board-profile': 'lemur', 'x-board-session': 'thread-1' })).toMatchObject({ status: 200, body: { profile: 'lemur' } })
  })

  it('do at most what their scope says, and a channel glob is its subtree', async () => {
    const { fetch } = factoryBoard()
    const { token, can } = await mint(fetch, await deploymentToken(), { scope: 'feedback/*=post' })
    expect(can).toEqual({ 'feedback/': ['post'] })
    const widget = caller(fetch, token)
    expect((await widget('POST', '/messages', { channel: 'feedback/web', text: 'love it' })).status).toBe(201)
    expect(await widget('POST', '/messages', { channel: 'dev', text: 'hi' })).toMatchObject({ status: 403 })
    expect(await widget('GET', '/messages?channel=feedback/web')).toMatchObject({ status: 200, body: { messages: [] } })
  })

  it('never widen what the minter may do, then or later', async () => {
    const { fetch } = testBoard({ access: [vercelProject({ project: 'prj_marketing', can: { dev: ['read'] } })] })
    const { token, can } = await mint(fetch, await deploymentToken(), { scope: '*=all' })
    expect(can).toEqual({ dev: ['read'] })
    expect(await caller(fetch, token)('POST', '/messages', { channel: 'dev', text: 'hi' })).toMatchObject({ status: 403 })
    // x-board-scope narrows a delegate further, and can't widen it back.
    const narrowed = caller(fetch, token, { 'x-board-scope': 'dev=read;ops=all' })
    expect((await narrowed('GET', '/me')).body.can).toEqual({ dev: ['read'] })
  })

  it('can’t mint, link accounts, register watchers, or import as sync', async () => {
    const { fetch } = factoryBoard()
    const { token } = await mint(fetch, await deploymentToken(), { profile: 'lemur' })
    const agent = caller(fetch, token)
    expect(await agent('POST', '/tokens', {})).toMatchObject({ status: 403, body: { error: { message: "this is a delegate token, so it can't mint another token" } } })
    expect(await agent('GET', '/identity')).toMatchObject({ status: 403 })
    expect(await agent('POST', '/sync/codes', { sync: 'slack' })).toMatchObject({ status: 403 })
    expect(await agent('POST', '/watchers', { url: 'https://agent.example.com/api/board', watch: { fix: { tail: 'dev' } } })).toMatchObject({
      status: 403,
      body: { error: { message: "this token is a delegate token: registering and running watchers is its project's job" } },
    })
  })

  it('aren’t minted for a caller narrowed with x-board-scope', async () => {
    const { fetch } = factoryBoard()
    const narrowed = caller(fetch, await deploymentToken(), { 'x-board-scope': 'dev=read' })
    expect(await narrowed('POST', '/tokens', {})).toMatchObject({ status: 403 })
  })

  it('for a person keep their handle, and never outlive their token', async () => {
    const { fetch } = testBoard()
    const person = await personToken()
    const { token, expiresAt } = await mint(fetch, person, { profile: 'claude', ttl: '1d' }, { 'x-board-handle': 'julian' })
    // Capped at 2h, and at the person's own token's hour.
    expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual((decodeJwt(person).exp as number) * 1000)
    const agent = caller(fetch, token, { 'x-board-handle': 'mallory' })
    expect((await agent('GET', '/me')).body).toMatchObject({ principal: 'vercel:user:u_julian', handle: 'julian/claude', kind: 'agent' })
  })

  it('cap ttl at two hours', async () => {
    // The board's own code mints with no expiry of its own.
    const { expiresAt } = await testBoard().token({ ttl: '1d' })
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 3600_000 + 1000)
  })

  it('minted in process act as the board’s own code, narrowed', async () => {
    const board = testBoard()
    const { token } = await board.token({ profile: 'eve-1', session: 'thread-1', can: { 'dev/': ['read', 'post'] } })
    const agent = caller(board.fetch, token)
    expect((await agent('GET', '/me')).body).toMatchObject({ principal: 'board:client', profile: 'eve-1', session: 'thread-1', can: { 'dev/': ['read', 'post'] } })
    expect((await agent('POST', '/messages', { channel: 'dev', text: 'hi' })).status).toBe(201)
    expect((await agent('POST', '/messages', { channel: 'ops', text: 'hi' })).status).toBe(403)
  })

  it('that another board or anyone else signed are refused', async () => {
    const { fetch } = testBoard()
    expect(await caller(fetch, (await testBoard().token()).token)('GET', '/me')).toMatchObject({ status: 401 })
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const forged = await new SignJWT({ board: { kind: 'person', handle: 'julian', scope: '*=all', profile: null, avatar: null, session: null, name: null } })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'nope', typ: 'board-delegate+jwt' })
      .setIssuer(BOARD_URL)
      .setAudience(BOARD_URL)
      .setSubject('vercel:user:u_julian')
      .setJti('x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)
    expect(await caller(fetch, forged)('GET', '/me')).toMatchObject({ status: 401 })
  })

  it('verify by the keys the board publishes', async () => {
    const board = testBoard()
    const response = await board.fetch(new Request(`${BOARD_URL}/.well-known/jwks.json`))
    expect(response.status).toBe(200)
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] }
    expect(keys).toEqual([expect.objectContaining({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' })])
    expect(keys[0]).not.toHaveProperty('d')
    const { token } = await board.token()
    expect(decodeProtectedHeader(token).kid).toBe(keys[0]!.kid)
  })
})
