import { describe, expect, it } from 'vitest'
import { displayText as display, vercelDeployments, VERCEL_BOT } from '../src/contract/bots.ts'
import { formatMessage } from '../src/cli/format.ts'
import type { MessageView } from '../src/api/routes.ts'
import { VERCEL_BUILDING, VERCEL_WITH_SKIPPED } from './vercel-fixtures.ts'

const displayText = (text: string) => display(text, VERCEL_BOT)

describe('known bot messages', () => {
  it('reads the deployments out of a Vercel for GitHub comment', () => {
    expect(vercelDeployments(VERCEL_BUILDING)).toEqual([
      {
        project: 'vboard-factory',
        projectUrl: 'https://vercel.com/vercel-internal-playground/vboard-factory',
        status: 'Building',
        deploymentUrl: 'https://vercel.com/vercel-internal-playground/vboard-factory/7ZEaNBTETQjaUF4Bd1VCxbM8rR3n',
        previewUrl: 'https://vboard-factory-git-pi-224.playground-vercel.tools',
        updated: 'Oct 6, 2026 8:30pm UTC',
        skipped: false,
      },
    ])
    const [built, skipped] = vercelDeployments(VERCEL_WITH_SKIPPED)!
    expect(built).toMatchObject({ project: 'vboard-factory', status: 'Building', skipped: false })
    expect(skipped).toMatchObject({ project: 'vboard', status: 'Ignored', previewUrl: null, skipped: true, updated: 'Oct 6, 2026 5:25pm UTC' })
  })

  it('shows one line per deployment, without the marker, the HTML, or the table', () => {
    const text = displayText(VERCEL_WITH_SKIPPED)
    expect(text).toBe(
      [
        '**▲ Vercel**',
        '- ⏳ **[vboard-factory](https://vercel.com/vercel-internal-playground/vboard-factory)** · [Building](https://vercel.com/vercel-internal-playground/vboard-factory/AKYQCQiM4Vf5Zp1AAcH6nQDYUC4n) · [Preview](https://vboard-factory-git-changeset-release-main.playground-vercel.tools) · Oct 6, 2026 5:25pm UTC',
        '- ⚪ **[vboard](https://vercel.com/basehub/vboard)** · [Ignored](https://vercel.com/basehub/vboard/Go3sKM9tee9TraPTMa71Haa1uZzj) (skipped) · Oct 6, 2026 5:25pm UTC',
      ].join('\n'),
    )
    expect(displayText(VERCEL_BUILDING.replace(/building/gi, 'Ready'))).toContain('- ✅ **[vboard-factory]')
    expect(displayText(VERCEL_BUILDING.replace(/building/gi, 'Error'))).toContain('- ❌ **[vboard-factory]')
  })

  it('leaves every other message alone, even one that quotes a Vercel table', () => {
    expect(displayText('hello')).toBe('hello')
    const quoted = `look at this:\n${VERCEL_BUILDING}`
    expect(displayText(quoted)).toBe(quoted)
  })

  it('only reads Vercel comments that Vercel wrote', () => {
    expect(display(VERCEL_BUILDING, 'github:user:42')).toBe(VERCEL_BUILDING)
    expect(display(VERCEL_BUILDING, 'slack:user:U1')).toBe(VERCEL_BUILDING)
    expect(display(VERCEL_BUILDING, VERCEL_BOT)).toContain('- ⏳ **[vboard-factory]')
  })

  it('reads a comment with CRLF line endings', () => {
    expect(displayText(VERCEL_WITH_SKIPPED.replace(/\n/g, '\r\n'))).toBe(
      [
        '**▲ Vercel**',
        '- ⏳ **[vboard-factory](https://vercel.com/vercel-internal-playground/vboard-factory)** · [Building](https://vercel.com/vercel-internal-playground/vboard-factory/AKYQCQiM4Vf5Zp1AAcH6nQDYUC4n) · [Preview](https://vboard-factory-git-changeset-release-main.playground-vercel.tools) · Oct 6, 2026 5:25pm UTC',
        '- ⚪ **[vboard](https://vercel.com/basehub/vboard)** · [Ignored](https://vercel.com/basehub/vboard/Go3sKM9tee9TraPTMa71Haa1uZzj) (skipped) · Oct 6, 2026 5:25pm UTC',
      ].join('\n'),
    )
  })

  it('shows the readable form in vb read, and the original in --json', () => {
    const message = {
      id: 253, channel: 'dev', text: VERCEL_BUILDING, re: null, replyTo: null, labels: {}, reactions: {}, createdAt: new Date().toISOString(), editedAt: null,
      deleted: false, attachments: [], undelivered: {}, by: { actor: 'github:user:35613825', principal: 'github:user:35613825', profile: null, session: null },
      author: { kind: 'external', handle: 'vercel[bot]', name: 'vercel[bot]', avatar: null },
    } as unknown as MessageView
    const out = formatMessage(message)
    expect(out).toContain('⏳ **[vboard-factory]')
    expect(out).not.toContain('[vc]:')
    expect(out).not.toContain('<relative-time')
  })
})
