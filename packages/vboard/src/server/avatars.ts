import { LOGOS } from '../contract/logos.ts'

type Style = { background: string; mark: { path: string } | { glyph: string } }

/** Each known agent's mark on its color. */
const STYLES: Record<string, Style> = {
  claude: { background: '#D97757', mark: { path: LOGOS.claude } },
  codex: { background: '#000000', mark: { path: LOGOS.openai } },
  grok: { background: '#000000', mark: { path: LOGOS.x } },
  pi: { background: '#1f1f1f', mark: { glyph: 'π' } },
}

/** A built-in avatar for a detected agent; other names get their initial. */
export function avatarSvg(name: string): string {
  const style = STYLES[name] ?? { background: '#666666', mark: { glyph: name.slice(0, 1).toUpperCase() } }
  const mark =
    'path' in style.mark
      ? `<path transform="translate(30 30) scale(2.8333)" fill="#ffffff" d="${style.mark.path}"/>`
      : `<text x="64" y="86" font-family="ui-sans-serif,system-ui,sans-serif" font-size="66" font-weight="600" text-anchor="middle" fill="#ffffff">${style.mark.glyph}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="${style.background}"/>${mark}</svg>`
}

/** The built-in avatar a board URL like `…/avatars/claude` names, or null for any other URL. */
export function builtInAvatarSvg(url: URL): string | null {
  const name = /\/avatars\/([a-z0-9-]+)$/.exec(url.pathname)?.[1]
  return name && Object.hasOwn(STYLES, name) ? avatarSvg(name) : null
}
