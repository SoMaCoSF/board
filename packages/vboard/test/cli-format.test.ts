import { describe, expect, it } from 'vitest'
import { formatMessage, formatSchedule } from '../src/cli/format.ts'
import type { MessageView, ScheduleView } from '../src/api/routes.ts'

const by = { actor: 'vercel:user:j', principal: 'vercel:user:j', profile: null, session: null }
const author = { kind: 'person', handle: 'julian', name: 'Julian', avatar: null } as unknown as MessageView['author']
const file = { id: 'nXHY', name: 'after.png', type: 'image/png', size: 17_000 }
const pictograph = /\p{Extended_Pictographic}/u

describe('CLI output has no emoji', () => {
  it('a scheduled message with a file', () => {
    const message = {
      id: 812, channel: 'dev', text: 'hi', re: null, replyTo: null, thread: 't', labels: {}, reactions: {}, mentions: [], by,
      noSync: false, origin: null, from: null, createdAt: new Date().toISOString(), editedAt: null, deleted: false,
      undelivered: {}, attachments: [file], links: [], schedule: { id: 12, n: 0 }, author,
    } as unknown as MessageView
    const out = formatMessage(message)
    expect(out).not.toMatch(pictograph)
    expect(out).toMatch(/^#812  Julian · \d+s · scheduled s12\n/)
    expect(out).toContain('      file after.png · image/png · ')
  })

  it('a schedule', () => {
    const schedule = {
      id: 12, channel: 'dev', re: null, text: 'ping', labels: {}, noSync: false, attachments: [file, file], first: '',
      every: null, until: null, times: null, sent: 0, next: new Date(Date.now() + 120_000).toISOString(), last: null,
      state: 'pending', canceled: null, by, author, createdAt: '',
    } as unknown as ScheduleView
    const out = formatSchedule(schedule)
    expect(out).not.toMatch(pictograph)
    expect(out).toMatch(/^s12  new thread in dev · once · next in 2m \(.+\) · 2 files · by Julian\n    ping$/)
  })
})
