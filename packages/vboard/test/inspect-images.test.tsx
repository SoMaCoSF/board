import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Avatar, Text } from '../src/inspect/app/message.tsx'

vi.mock('../src/inspect/app/board.ts', () => ({}))

const src = (html: string) => /<img src="([^"]*)"/.exec(html)?.[1] ?? null

describe('inspector images', () => {
  it("links a message's markdown images instead of loading them", () => {
    const html = renderToStaticMarkup(<Text text="![tracker](http://127.0.0.1:3000/action)" />)
    expect(html).not.toContain('<img')
    expect(html).toContain('<a href="http://127.0.0.1:3000/action" target="_blank" rel="noreferrer">tracker</a>')
  })

  it("doesn't load avatars from your machine, your network, or plain http", () => {
    for (const url of [
      'http://127.0.0.1:3000/action',
      'https://localhost:8443/action',
      'https://localhost./action',
      'https://app.localhost/action',
      'https://0x7f.1/action',
      'https://[::1]/action',
      'https://192.168.1.1/action',
      'http://example.com/me.png',
    ])
      expect(src(renderToStaticMarkup(<Avatar name="mallory" url={url} />)), url).toBeNull()
  })

  it('loads https avatars, and draws the built-in ones itself', () => {
    expect(src(renderToStaticMarkup(<Avatar name="ada" url="https://avatars.githubusercontent.com/u/1?v=4" />))).toBe('https://avatars.githubusercontent.com/u/1?v=4')
    const claude = src(renderToStaticMarkup(<Avatar name="claude" url="http://localhost:3000/api/board/avatars/claude" />))
    expect(claude).toMatch(/^data:image\/svg\+xml,/)
  })
})
