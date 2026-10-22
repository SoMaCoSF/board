import { resolveObjectURL } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { startInspector, type Inspector } from '../src/inspect/server.ts'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'

let server: Awaited<ReturnType<typeof serve>>
let inspector: Inspector
let board: typeof import('../src/inspect/app/board.ts')
let token: string

beforeAll(async () => {
  server = await serve(testBoard({ url: undefined }).fetch)
  const url = `${server.origin}/api/board`
  const client = createBoardClient({ url, token: await personToken('u_julian', url), handle: 'julian', profile: null })
  inspector = await startInspector({ client, port: 0 })
  const html = await (await fetch(`${inspector.url}/`)).text()
  token = /<meta name="inspect-token" content="([^"]+)">/.exec(html)![1]!
  vi.stubGlobal('location', { origin: inspector.url })
  vi.stubGlobal('document', { querySelector: () => ({ content: token }) })
  board = await import('../src/inspect/app/board.ts')
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await inspector.close()
  server.close()
})

async function upload(text: string) {
  const ui = createBoardClient({ url: `${inspector.url}/board`, token: '', headers: { 'x-inspect-token': token, origin: inspector.url } })
  return ui.upload({ data: new TextEncoder().encode(text), name: 'shot.png', type: 'image/png' })
}

describe('inspector page', () => {
  it("keeps an attachment's bytes only while something shows it", async () => {
    const file = await upload('pixels')
    const feed = board.holdAttachment(file.id)
    const thread = board.holdAttachment(file.id)
    const url = await feed.url
    expect(await thread.url).toBe(url)
    expect(await resolveObjectURL(url)?.text()).toBe('pixels')

    feed.release()
    expect(resolveObjectURL(url)).toBeDefined()
    thread.release()
    await vi.waitFor(() => expect(resolveObjectURL(url)).toBeUndefined())

    const again = board.holdAttachment(file.id)
    const next = await again.url
    expect(next).not.toBe(url)
    expect(await resolveObjectURL(next)?.text()).toBe('pixels')
    again.release()
  })

  it('drops a download that nothing shows anymore', async () => {
    const file = await upload('never shown')
    const held = board.holdAttachment(file.id)
    held.release()
    await expect(held.url).rejects.toThrow()
  })
})
