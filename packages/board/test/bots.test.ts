import { describe, expect, it } from 'vitest'
import { displayText as display, vercelDeployments, VERCEL_BOT } from '../src/contract/bots.ts'
import { block, blocksIn } from '../src/contract/blocks.ts'
import { BUILT_IN_SCHEMAS } from '../src/contract/data-schemas.ts'
import { checkValue } from '../src/contract/data-values.ts'
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
        updatedAt: '2026-10-06T20:30:32.400Z',
        skipped: false,
      },
    ])
    const [built, skipped] = vercelDeployments(VERCEL_WITH_SKIPPED)!
    expect(built).toMatchObject({ project: 'vboard-factory', status: 'Building', skipped: false })
    expect(skipped).toMatchObject({ project: 'vboard', status: 'Ignored', previewUrl: null, skipped: true, updated: 'Oct 6, 2026 5:25pm UTC', updatedAt: '2026-10-06T17:25:54.038Z' })
  })

  describe('where what shows them has a view of deployments', () => {
    const shows = (schema: string) => schema === 'vercel-deployments@1'
    const factory = {
      project: 'vboard-factory',
      state: 'building',
      url: 'https://vboard-factory-git-changeset-release-main.playground-vercel.tools',
      environment: 'preview',
      inspectorUrl: 'https://vercel.com/vercel-internal-playground/vboard-factory/AKYQCQiM4Vf5Zp1AAcH6nQDYUC4n',
      projectUrl: 'https://vercel.com/vercel-internal-playground/vboard-factory',
      updatedAt: '2026-10-06T17:25:54.038Z',
    }

    it("are that schema's block, with the ones Vercel skipped in a line under it", () => {
      const shown = display(VERCEL_WITH_SKIPPED, VERCEL_BOT, shows)
      expect(shown).toBe(`**▲ Vercel**\n\n${block('vercel-deployments@1', { deployments: [factory] })}\n\n1 skipped: [vboard](https://vercel.com/basehub/vboard)`)
      // What the board would take: the block is one it finds, and its data matches the built-in.
      expect(blocksIn(shown)).toEqual([{ schema: 'vercel-deployments', version: 1, data: { deployments: [factory] } }])
      expect(checkValue(BUILT_IN_SCHEMAS.find((schema) => schema.name === 'vercel-deployments')!.schema, { deployments: [factory] })).toBeNull()
    })

    it('name each state as the schema does', () => {
      const states = (status: string) => blocksIn(display(VERCEL_BUILDING.replace(/building/gi, status), VERCEL_BOT, shows)).map((found) => (found.data.deployments as { state: string }[])[0]!.state)
      expect(['Queued', 'Initializing', 'Building', 'Ready', 'Error', 'Failed', 'Canceled'].map((status) => states(status)[0])).toEqual(['queued', 'building', 'building', 'ready', 'error', 'error', 'canceled'])
    })

    it("stay a line each when the schema can't hold them: a state it doesn't know, or none that Vercel built", () => {
      expect(display(VERCEL_BUILDING.replace(/building/gi, 'Promoting'), VERCEL_BOT, shows)).toContain('- ▲ **[vboard-factory]')
      const onlySkipped = VERCEL_WITH_SKIPPED.replace(/\| <a[^\n]*Building[^\n]*\n/, '')
      expect(display(onlySkipped, VERCEL_BOT, shows)).toBe(displayText(onlySkipped))
      expect(displayText(onlySkipped)).toContain('(skipped)')
    })

    it("stay a line each for what has no view of them, and stay Vercel's alone", () => {
      expect(display(VERCEL_BUILDING, VERCEL_BOT, (schema) => schema === 'git-commit@1')).toBe(displayText(VERCEL_BUILDING))
      expect(display(VERCEL_BUILDING, 'github:user:42', shows)).toBe(VERCEL_BUILDING)
    })
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
      deleted: false, attachments: [], undelivered: {}, by: { actor: 'github:user:35613825', principal: 'github:user:35613825', profile: null },
      author: { kind: 'external', handle: 'vercel[bot]', name: 'vercel[bot]', avatar: null },
    } as unknown as MessageView
    const out = formatMessage(message)
    expect(out).toContain('⏳ **[vboard-factory]')
    expect(out).not.toContain('[vc]:')
    expect(out).not.toContain('<relative-time')
  })
})
