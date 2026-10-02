import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { formatThreads } from '../src/cli/format.ts'

const message = {
  id: 83,
  channel: 'bugs',
  re: null,
  text: 'reactions show raw ids',
  labels: {},
  reactions: { bug: ['vboard:watch:triage'] },
  by: { actor: 'u_julian', profile: null },
  author: { id: 'u_julian', handle: 'julian', name: 'Julián Benegas', avatar: null },
  createdAt: new Date().toISOString(),
  editedAt: null,
  deleted: false,
} as unknown as MessageView

describe('formatThreads', () => {
  it('names reactors who have not written in view, from the actor directory', () => {
    const out = formatThreads([message], [{ id: 'vboard:watch:triage', name: 'triage' }])
    expect(out).toContain('🐛 triage')
    expect(out).not.toContain('vboard:watch:triage')
  })

  it('falls back to the raw id when the actor is unknown', () => {
    expect(formatThreads([message])).toContain('🐛 vboard:watch:triage')
  })
})
