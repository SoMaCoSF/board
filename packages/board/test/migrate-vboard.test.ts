import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// What vboard 0.14 wrote, as it wrote it: the last release before the rename.
import { board as vboard } from 'vboard'
import { a2 as vboardA2, memoryBlob } from 'vboard/backend-a2'
import { sqlite as vboardSqlite } from 'vboard/backend-a2/store-sqlite'
import { localScheduler as vboardScheduler } from 'vboard/backend-a2/scheduler-local'
import { board } from '../src/server/index.ts'
import { a2, migrateFromVboard, replayClock } from '../src/backend-a2/index.ts'
import { sqlite } from '../src/store/sqlite.ts'

const URL = 'http://board.test/api/board'

async function vboardWrote() {
  const path = join(await mkdtemp(join(tmpdir(), 'vboard-')), 'board.db')
  const old = vboard({ backend: vboardA2({ store: vboardSqlite({ path }), scheduler: vboardScheduler() }), url: URL })
  const root = await old.post('dev', 'deploys are down')
  const reply = await old.reply(root.id, 'looking')
  await old.react(root.id, 'eyes')
  await old.edit(reply.id, 'looking, it was the CDN')
  const schedule = await old.schedule({ re: root.id }, { text: 'still down?', in: '1d' })
  const before = { thread: await old.thread(root.id), schedules: await old.schedules() }
  return { path, root, schedule, before }
}

describe('migrateFromVboard', () => {
  it("copies vboard's board, keeping IDs, times, threads, and schedules", async () => {
    const { path, root, schedule, before } = await vboardWrote()
    const clock = replayClock()
    const store = sqlite({ path, clock })
    const reports = await migrateFromVboard({ store, clock })
    expect(reports.find((report) => report.to === 'board\u001fboard')).toMatchObject({ copied: expect.any(Number), existing: 0 })
    expect(reports.find((report) => report.to === 'board-schedules\u001fschedules')!.copied).toBeGreaterThan(0)

    const now = board({ backend: a2({ store }), url: URL })
    const thread = await now.thread(root.id)
    expect(thread.message.thread).toBe(before.thread.message.thread)
    expect(thread.message).toMatchObject({ id: root.id, text: 'deploys are down', createdAt: before.thread.message.createdAt, reactions: { eyes: ['board:client'] } })
    expect(thread.replies.map((reply) => [reply.id, reply.text, reply.createdAt, reply.editedAt])).toEqual(
      before.thread.replies.map((reply) => [reply.id, reply.text, reply.createdAt, reply.editedAt]),
    )
    // vboard's own principal is board's now.
    expect(thread.message.by.actor).toBe('board:client')
    expect((await now.schedules()).map((s) => [s.id, s.text, s.next])).toEqual([[schedule.id, 'still down?', before.schedules[0]!.next]])
    // New posts follow on.
    const next = await now.reply(root.id, 'back up')
    expect(Number(next.id)).toBeGreaterThan(Number(before.thread.replies.at(-1)!.id))
    expect((await now.thread(root.id)).replies.map((reply) => reply.text)).toEqual(['looking, it was the CDN', 'back up'])
  })

  it('picks up where a run stopped, and refuses a board that already wrote', async () => {
    const { path } = await vboardWrote()
    const clock = replayClock()
    const store = sqlite({ path, clock })
    const first = await migrateFromVboard({ store, clock })
    const again = await migrateFromVboard({ store, clock })
    expect(again.map((report) => report.copied)).toEqual(first.map(() => 0))
    expect(again.map((report) => report.existing)).toEqual(first.map((report) => report.copied))

    const copy = await vboardWrote()
    const theirs = sqlite({ path: copy.path, clock })
    await board({ backend: a2({ store: theirs }), url: URL }).post('dev', 'written before migrating')
    await expect(migrateFromVboard({ store: theirs, clock })).rejects.toThrow("already has events that aren't")
  })

  it("wakes no watcher for what it copied", async () => {
    const { path } = await vboardWrote()
    const clock = replayClock()
    const store = sqlite({ path, clock })
    await migrateFromVboard({ store, clock })
    const seen: string[] = []
    const now = board({
      backend: a2({ store }),
      url: URL,
      watch: { echo: { tail: 'dev', run: async ({ event }) => void (event.message && seen.push(event.message.text)) } },
    })
    await now.post('dev', 'after')
    await vi.waitFor(() => expect(seen).toContain('after'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(seen).toEqual(['after'])
  })

  it("copies each message's files to where board reads them", async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'vboard-')), 'board.db')
    const blob = memoryBlob()
    const old = vboard({ backend: vboardA2({ store: vboardSqlite({ path }), blob }), url: URL })
    const file = await old.upload({ name: 'shot.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) })
    const root = await old.post('dev', { text: 'see shot', attachments: [file.id] })
    const clock = replayClock()
    const store = sqlite({ path, clock })
    const reports = await migrateFromVboard({ store, clock, blob })
    expect(reports[0]).toMatchObject({ files: 1 })
    const now = board({ backend: a2({ store, blob }), url: URL })
    expect((await now.thread(root.id)).message.attachments).toEqual([expect.objectContaining({ id: file.id, name: 'shot.png' })])
    const download = await now.download(file.id)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect((await migrateFromVboard({ store, clock, blob }))[0]).toMatchObject({ files: 0 })
  })
})
