import { idempotentId } from 'experimental-a2'
import { describe, expect, it, vi } from 'vitest'
import type { BoardEventView } from '../src/api/routes.ts'
import { parseTail, parseWatchTail, words } from '../src/api/tail.ts'
import type { Json, Watcher } from '../src/server/index.ts'
import { runMatch } from '../src/server/watch.ts'
import { caller, personToken, testBoard } from './harness.ts'
import { fakeQueue } from './queue.ts'

/** A watcher that records every event it runs on. */
function recorder(tail: string) {
  const events: BoardEventView[] = []
  const watcher: Watcher = { tail, run: ({ event }) => void events.push(event) }
  return { watcher, events, types: () => events.map((event) => event.type) }
}

describe('tail expressions', () => {
  it('split like a shell and parse like the CLI', () => {
    expect(words(`firehose --text "deploy failed" --label 'state=open|draft' a\\ b`)).toEqual([
      'firehose',
      '--text',
      'deploy failed',
      '--label',
      'state=open|draft',
      'a b',
    ])
    expect(parseTail('prs/ --label pr --mentions @claude --re #12')).toEqual({
      channel: 'prs/',
      label: [['pr', null]],
      mentions: 'claude',
      re: '12',
    })
    expect(parseTail('prs --label pr --roots')).toEqual({ channel: 'prs', label: [['pr', null]], roots: true })
    expect(parseTail('--mentions')).toEqual({ mentions: 'me' })
    expect(parseTail('')).toEqual({})
    expect(parseWatchTail('prs --label pr --all')).toEqual({ filters: { channel: 'prs', label: [['pr', null]] }, all: true })
    expect(parseWatchTail('prs').all).toBe(false)
  })

  it('reject what a filter is not', () => {
    expect(() => parseTail('firehose --after 3')).toThrow("--after isn't a filter")
    expect(() => parseTail('firehose prs')).toThrow('expected one channel, got: firehose prs')
    expect(() => parseTail('--text "open')).toThrow('unterminated "')
  })
})

describe('watchers', () => {
  it('run on what the same `vb tail` prints, exactly as it prints it', async () => {
    const triage = recorder('firehose')
    const { fetch } = testBoard({ watch: { triage: triage.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    await julian('POST', '/messages', { channel: 'other', text: 'unrelated' })
    await julian('POST', `/messages/${root.body.message.id}/reactions`, { emoji: 'eyes' })

    await vi.waitFor(() => expect(triage.types()).toEqual(['message.posted', 'reaction.added']))
    const tail = await julian('GET', '/events?channel=firehose&after=0')
    expect(triage.events).toEqual(tail.body.events)
  })

  it('wake when a thread enters their view, then on its replies', async () => {
    const wake = recorder('--label status=needs-agent')
    const { fetch } = testBoard({ watch: { wake: wake.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    await julian('POST', `/messages/${root.id}/labels`, { set: { status: 'needs-agent' } })
    await julian('POST', '/messages', { re: root.id, text: 'still broken' })

    await vi.waitFor(() => expect(wake.types()).toEqual(['labels.changed', 'message.posted']))
    expect(wake.events[1]!.message).toMatchObject({ text: 'still broken', re: root.id })
  })

  it('wake on replies in labeled threads only, like a review watcher on `prs --label pr`', async () => {
    const review = recorder('prs --label pr')
    const { fetch } = testBoard({ watch: { review: review.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const pr = (await julian('POST', '/messages', { channel: 'prs', text: 'PR #12', labels: { pr: 'acme/www#12' } })).body.message
    const chat = (await julian('POST', '/messages', { channel: 'prs', text: 'who owns the release?' })).body.message
    await julian('POST', '/messages', { re: chat.id, text: 'me' })
    await julian('POST', '/messages', { re: pr.id, text: 'looks good' })

    await vi.waitFor(() => expect(review.events.map((event) => event.message?.text)).toEqual(['PR #12', 'looks good']))
  })

  it('wake only on PR roots with --roots, never on their replies', async () => {
    const merge = recorder('prs --label pr --roots')
    const { fetch } = testBoard({ watch: { merge: merge.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const pr = (await julian('POST', '/messages', { channel: 'prs', text: 'PR #12', labels: { pr: 'acme/www#12' } })).body.message
    const reply = (await julian('POST', '/messages', { re: pr.id, text: 'looks good' })).body.message
    await julian('POST', `/messages/${reply.id}/reactions`, { emoji: 'shipit' })
    await julian('POST', `/messages/${pr.id}/reactions`, { emoji: 'shipit' })

    await vi.waitFor(() => expect(merge.types()).toEqual(['message.posted', 'reaction.added']))
    expect(merge.events.map((event) => event.message?.id)).toEqual([pr.id, pr.id])
  })

  it('wake for any of a label\'s values, and not for others', async () => {
    const wake = recorder('--label kind=bug|feature|question')
    const { fetch } = testBoard({ watch: { wake: wake.watcher } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const noise = (await julian('POST', '/messages', { channel: 'firehose', text: 'lunch?' })).body.message
    await julian('POST', `/messages/${noise.id}/labels`, { set: { kind: 'noise' } })
    await julian('POST', '/messages', { re: noise.id, text: 'pizza' })
    const feature = (await julian('POST', '/messages', { channel: 'firehose', text: 'add exports' })).body.message
    await julian('POST', `/messages/${feature.id}/labels`, { set: { kind: 'feature' } })
    await julian('POST', '/messages', { re: feature.id, text: 'csv please' })

    await vi.waitFor(() => expect(wake.types()).toEqual(['labels.changed', 'message.posted']))
    expect(wake.events.map((event) => event.message?.re ?? event.message?.id)).toEqual([feature.id, feature.id])
  })

  it('match mentions by handle', async () => {
    const pinged = recorder('--mentions @ada')
    const { fetch } = testBoard({ watch: { pinged: pinged.watcher } })
    const ada = caller(fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    await ada('POST', '/messages', { channel: 'firehose', text: 'hi' })
    await julian('POST', '/messages', { channel: 'firehose', text: '@ada can you look?' })

    await vi.waitFor(() => expect(pinged.events.map((event) => event.message?.text)).toEqual(['@ada can you look?']))
  })

  it('match authors by handle, with or without the @', async () => {
    const fromAda = recorder('firehose --by @ada')
    const { fetch } = testBoard({ watch: { 'from-ada': fromAda.watcher } })
    const ada = caller(fetch, await personToken('u_ada'), { 'x-board-handle': 'ada' })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    await julian('POST', '/messages', { channel: 'firehose', text: 'from julian' })
    await ada('POST', '/messages', { channel: 'firehose', text: 'from ada' })

    await vi.waitFor(() => expect(fromAda.events.map((event) => event.message?.text)).toEqual(['from ada']))
  })

  it("write as themselves, and their own writes don't wake them", async () => {
    const seen = recorder('firehose')
    const board = testBoard({
      watch: {
        triage: {
          tail: 'firehose',
          run: async ({ event, board }) => {
            if (event.type === 'message.posted') await board.reply(event.message!.id, 'Thanks! Tracking it.')
          },
        },
        seen: seen.watcher,
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    await vi.waitFor(() => expect(seen.types()).toEqual(['message.posted', 'message.posted']))
    expect(seen.events[1]!.message).toMatchObject({
      text: 'Thanks! Tracking it.',
      by: { actor: 'vboard:watch:triage' },
      author: { handle: 'triage', kind: 'deployment' },
    })
    // Matches are recorded before anything runs, so triage's session is final: one match, not two.
    const watchServer = board.servers.at(-1)!
    expect(await watchServer.session('watch:triage').history()).toHaveLength(1)
  })

  it.each(['/api/board', '/api/board/'])('read and write through a board mounted at an explicit basePath %s', async (basePath) => {
    const results: unknown[] = []
    const board = testBoard({
      basePath,
      watch: {
        triage: {
          tail: 'firehose',
          run: async ({ event, board }) => {
            if (event.type !== 'message.posted' || event.message!.re !== null) return
            try {
              await board.react(event.message!.id, 'eyes')
              await board.reply(event.message!.id, 'on it')
              results.push((await board.thread(event.message!.id)).replies.length)
            } catch (error) {
              results.push((error as Error).message)
            }
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    await vi.waitFor(() => expect(results).toEqual([1]))
    const after = (await julian('GET', `/messages/${root.id}`)).body
    expect(after.message.reactions).toEqual({ eyes: ['vboard:watch:triage'] })
  })

  it("fail on their own: a broken watcher doesn't hold up writes or other watchers", async () => {
    const ok = recorder('firehose')
    const { fetch } = testBoard({
      watch: {
        broken: {
          tail: 'firehose',
          run: () => {
            throw new Error('boom')
          },
        },
        ok: ok.watcher,
      },
    })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    expect(root.status).toBe(201)
    expect((await julian('POST', '/messages', { re: root.body.message.id, text: 'still broken' })).status).toBe(201)
    await vi.waitFor(() => expect(ok.types()).toEqual(['message.posted', 'message.posted']))
  })

  it("give up on an event that keeps failing, and keep running on the thread's later events", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const board = testBoard({
      watch: {
        flaky: {
          tail: 'firehose',
          run: ({ event }) => {
            if (event.message?.text === 'boom') throw new Error('sandbox setup failed')
            seen.push(event.message!.text)
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'boom' })
    await julian('POST', '/messages', { re: root.body.message.id, text: 'are you alive?' })

    // Without a scheduler nothing retries on its own; each drain is the next try.
    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:flaky')
      await watches.drain('watch:flaky')
      expect(seen).toEqual(['are you alive?'])
    })
    const failed = (await watches.session('watch:flaky').history()).filter((event) => event.type === 'watch.failed')
    expect(failed).toEqual([expect.objectContaining({ payload: expect.objectContaining({ thread: root.body.message.thread, error: 'sandbox setup failed' }) })])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('watcher flaky gave up on event'), 'sandbox setup failed')
    error.mockRestore()
  })

  it('schedule once when a run that scheduled throws and is retried', async () => {
    const queue = fakeQueue()
    let runs = 0
    const board = testBoard({
      scheduler: queue.scheduler,
      watch: {
        reminder: {
          tail: 'firehose',
          run: async ({ event, board }) => {
            await board.schedule({ re: event.message!.id }, { text: 'still broken?', in: '1d' })
            if (runs++ === 0) throw new Error('sandbox setup failed')
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })

    const watches = board.servers.find((server) => server.contract.name === 'vboard-watch')!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:reminder')
      await watches.drain('watch:reminder')
      expect(runs).toBe(2)
    })
    expect((await julian('GET', '/schedules')).body.schedules).toMatchObject([{ text: 'still broken?' }])
  })

  it("run its failed hook once when it gives up on an event, with writes of its own, and go on", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failures: { error: string; attempts: number }[] = []
    const board = testBoard({
      watch: {
        pi: {
          tail: 'firehose',
          run: async ({ event, board }) => {
            if (event.message?.re !== null) return
            await board.reply(event.message.id, 'starting Pi')
            throw new Error('sandbox setup failed')
          },
          failed: async ({ event, board, error, attempts }) => {
            failures.push({ error, attempts })
            await board.reply(event.message!.id, `Pi couldn't start: ${error}`)
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })

    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:pi')
      await watches.drain('watch:pi')
      expect(failures).toHaveLength(1)
    })
    for (let n = 0; n < 3; n++) await watches.drain('watch:pi')
    expect(failures).toEqual([{ error: 'sandbox setup failed', attempts: 5 }])
    const { body } = await julian('GET', `/messages/${root.body.message.id}`)
    expect(body.replies.map((reply: { text: string; by: { actor: string } }) => [reply.text, reply.by.actor])).toEqual([
      ['starting Pi', 'vboard:watch:pi'],
      ["Pi couldn't start: sandbox setup failed", 'vboard:watch:pi'],
    ])
    error.mockRestore()
  })

  it('record what a failed hook throws, and go on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recorded: unknown[] = []
    const match = { id: 'm1', payload: { thread: 't1', event: { cursor: '7', type: 'message.posted' } } }
    const failed = () => {
      throw new Error('slack is down')
    }
    const run = () => {
      throw new Error('sandbox setup failed')
    }
    await runMatch({ watcher: { id: 'pi', run, failed }, match, attempt: 5, record: async (failure) => void recorded.push(failure) })
    expect(recorded).toEqual([{ matched: 'm1', thread: 't1', error: 'sandbox setup failed', hook: 'slack is down' }])
    error.mockRestore()
  })

  it('give up without running once runs keep getting killed, which never throw, until a retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn()
    const failed = vi.fn()
    const recorded: unknown[] = []
    const match = { id: 'm1', payload: { thread: 't1', event: { cursor: '7', type: 'message.posted' } } }
    const input = { watcher: { id: 'pi', run, failed }, match, record: async (failure: unknown) => void recorded.push(failure) }

    // Short of twice the tries, a run gets another go: earlier attempts may have been kills.
    await runMatch({ ...input, attempt: 9 })
    expect(run).toHaveBeenCalledTimes(1)
    // The 10th is the last A2 hands out (it counts each kill as a failure at the next takeover,
    // and dead-letters at 10): give up, don't run again.
    await runMatch({ ...input, attempt: 10 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual([{ matched: 'm1', thread: 't1', error: 'its run was cut short 9 times (a timeout, or out of memory)' }])
    expect(failed.mock.calls).toEqual([[match.payload.event, { error: 'its run was cut short 9 times (a timeout, or out of memory)', attempts: 9 }]])
    expect(error).toHaveBeenCalledWith('[vboard] watcher pi gave up on event #7 after 10 tries:', 'its run was cut short 9 times (a timeout, or out of memory)')

    // Retried from a dead letter, A2 keeps counting: the run gets A2's fresh tries, and a throw goes back to A2.
    await runMatch({ ...input, attempt: 11 })
    expect(run).toHaveBeenCalledTimes(2)
    run.mockRejectedValueOnce(new Error('still down'))
    await expect(runMatch({ ...input, attempt: 16 })).rejects.toThrow('still down')
    expect(recorded).toHaveLength(1)
    expect(failed).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('fail the boot when one is misconfigured', () => {
    const run = () => {}
    expect(() => testBoard({ watch: { triage: { tail: 'firehose --after 3', run } } })).toThrow(
      "watch triage: --after isn't a filter",
    )
    expect(() => testBoard({ watch: { triage: { tail: '--mentions', run } } })).toThrow(
      'watch triage: a watcher has no "me": use --mentions @handle',
    )
    expect(() => testBoard({ watch: { Triage: { tail: '', run } } })).toThrow('watch: ids use lowercase')
  })
})

describe("the board's handle in its own deployment", () => {
  it('writes as `vboard:client`, or `vboard:client:<profile>` with `as`, and wakes watchers', async () => {
    const report = recorder('firehose --label state=done')
    const app = testBoard({ watch: { report: report.watcher } })
    const julian = caller(app.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message

    const hook = app.as('v0-hook')
    await hook.label(root.id, { set: { state: 'done' } })
    const reply = await hook.reply(root.id, 'fixed in #31')

    expect(reply.by).toMatchObject({ actor: 'vboard:client:v0-hook' })
    expect((await app.reply(root.id, 'and deployed')).by).toMatchObject({ actor: 'vboard:client' })
    expect((await app.me()).actor).toBe('vboard:client')
    await vi.waitFor(() => expect(report.types()).toEqual(['labels.changed', 'message.posted', 'message.posted']))
  })

  it("posts once per id, so a redelivered webhook does not post twice, and keeps each profile's ids its own", async () => {
    const app = testBoard()
    const julian = caller(app.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message

    const hook = app.as('v0-hook')
    const first = await hook.reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })
    const again = await app.as('v0-hook').reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })
    const other = await hook.reply(root.id, { text: 'fixed in #31', id: 'delivery-2' })
    const unkeyed = [await hook.reply(root.id, 'a'), await hook.reply(root.id, 'a')]

    expect(again.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
    expect(unkeyed[0]!.id).not.toBe(unkeyed[1]!.id)
    expect((await hook.posted('delivery-1')).id).toBe(first.id)
    // Another profile's, or the handle's own, with the same id is a post of its own.
    expect((await app.as('deploys').reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })).id).not.toBe(first.id)
    expect((await app.reply(root.id, { text: 'fixed in #31', id: 'delivery-1' })).id).not.toBe(first.id)
    // And no request can post with it first: what it derives is the board's own kind of ID.
    const taken = await julian('POST', '/messages', { re: root.id, text: 'mine now', id: 'delivery-3' })
    expect(taken.status).toBe(201)
    expect((await hook.reply(root.id, { text: 'fixed in #32', id: 'delivery-3' })).text).toBe('fixed in #32')
  })

  it('rejects a profile a watcher id would reject', async () => {
    await expect(testBoard().as('V0 Hook').me()).rejects.toThrow('as: profiles use lowercase letters')
  })
})

describe('watchers that run when a message enters the view', () => {
  it('run once per entry, not on later events that still match', async () => {
    const done = recorder('--label state=done')
    const { fetch } = testBoard({ watch: { done: { ...done.watcher, when: 'enters' } } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    await julian('POST', `/messages/${root.id}/labels`, { set: { state: 'done' } })
    await julian('POST', `/messages/${root.id}/labels`, { set: { state: 'done', pr: '31' } })
    await julian('POST', '/messages', { re: root.id, text: 'thanks' })
    await julian('POST', `/messages/${root.id}/labels`, { unset: ['state'] })
    await julian('POST', `/messages/${root.id}/labels`, { set: { state: 'done' } })

    await vi.waitFor(() => expect(done.types()).toEqual(['labels.changed', 'labels.changed']))
    expect(done.events.map((event) => event.payload)).toMatchObject([
      { set: { state: 'done' } },
      { set: { state: 'done' } },
    ])
  })

  it('run on a new thread that matches, but not on replies in a thread already in view', async () => {
    const urgent = recorder('firehose --label urgent')
    const { fetch } = testBoard({ watch: { urgent: { ...urgent.watcher, when: 'enters' } } })
    const julian = caller(fetch, await personToken(), { 'x-board-handle': 'julian' })

    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'down', labels: { urgent: 'yes' } })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'on it' })

    await vi.waitFor(() => expect(urgent.events.map((event) => event.message?.text)).toEqual(['down']))
  })

  it('need a filter to enter', () => {
    expect(() => testBoard({ watch: { all: { tail: '', when: 'enters', run: () => {} } } })).toThrow(
      'watch all: `when: enters` needs a filter to enter',
    )
  })
})

describe('once', () => {
  /** A thread's replies, as text and who posted them. */
  const repliesOf = async (julian: ReturnType<typeof caller>, id: string) =>
    ((await julian('GET', `/messages/${id}`)).body.replies as { text: string; by: { actor: string } }[]).map((reply) => [reply.text, reply.by.actor])

  it('posts what comes after a fn a retry skips, on IDs of its own', async () => {
    let calls = 0
    let runs = 0
    let finished = false
    const board = testBoard({
      watch: {
        w: {
          tail: 'firehose',
          run: async ({ event, board, once }) => {
            if (event.message?.re !== null) return
            const root = event.message.id
            await once('k', async () => {
              calls++
              await board.reply(root, 'A')
            })
            if (++runs === 1) throw new Error('cut short after once')
            await board.reply(root, 'B')
            finished = true
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:w')
      await watches.drain('watch:w')
      expect(finished).toBe(true)
    })
    expect(await repliesOf(julian, root.id)).toEqual([
      ['A', 'vboard:watch:w'],
      ['B', 'vboard:watch:w'],
    ])
    expect(calls, 'fn ran once').toBe(1)
  })

  it('schedules what comes after a fn a retry skips, on IDs of its own, and what fn scheduled once', async () => {
    let runs = 0
    let finished = false
    const board = testBoard({
      scheduler: fakeQueue().scheduler,
      watch: {
        w: {
          tail: 'firehose',
          run: async ({ event, board, once }) => {
            if (event.message?.re !== null) return
            const root = event.message.id
            await once('nudge', async () => {
              await board.schedule({ re: root }, { text: 'still broken?', in: '1d' })
            })
            if (++runs === 1) throw new Error('cut short after once')
            await board.schedule({ re: root }, { text: 'any update?', in: '2d' })
            finished = true
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    const watches = board.servers.find((server) => server.contract.name === 'vboard-watch')!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:w')
      await watches.drain('watch:w')
      expect(finished).toBe(true)
    })
    const { schedules } = (await julian('GET', '/schedules')).body
    expect(schedules.map((schedule: { text: string }) => schedule.text).sort()).toEqual(['any update?', 'still broken?'])
  })

  it('gives a retry what fn returned, without running it again', async () => {
    let calls = 0
    const got: unknown[] = []
    const board = testBoard({
      watch: {
        w: {
          tail: 'firehose',
          run: async ({ once }) => {
            got.push(
              await once('k', async () => {
                calls++
                return { pr: 12 }
              }),
            )
            if (got.length === 1) throw new Error('cut short after once')
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:w')
      await watches.drain('watch:w')
      expect(got).toHaveLength(2)
    })
    expect(got).toEqual([{ pr: 12 }, { pr: 12 }])
    expect(calls, 'fn ran once').toBe(1)
  })

  it('runs fn again when a run dies after its effect and before its record, and the effect lands once', async () => {
    let calls = 0
    let finished = false
    const board = testBoard({
      watch: {
        w: {
          tail: 'firehose',
          run: async ({ event, board, once }) => {
            if (event.message?.re !== null) return
            const root = event.message.id
            await once('k', async () => {
              calls++
              await board.reply(root, 'on it')
            })
            finished = true
          },
        },
      },
    })
    vi.spyOn(board.backend, 'recordOnce').mockRejectedValueOnce(new Error('killed'))
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:w')
      await watches.drain('watch:w')
      expect(finished).toBe(true)
    })
    expect(calls, 'fn ran again after the kill').toBe(2)
    expect(await repliesOf(julian, root.id)).toEqual([['on it', 'vboard:watch:w']])
    const record = await watches.session(`once:${await idempotentId('vboard-once', 'vboard:watch:w', 'k')}`).history()
    expect(record.map((event) => [event.type, event.payload])).toEqual([['watch.once', { actor: 'vboard:watch:w', key: 'k' }]])
  })

  it("keeps a watcher's keys across its events and its failed hook, apart from another watcher's", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ran: string[] = []
    const seen = { review: 0, other: 0 }
    const reviewer = (name: 'review' | 'other'): Watcher => ({
      tail: 'firehose',
      run: async ({ event, once }) => {
        const thread = event.message!.re ?? event.message!.id
        await once(`review:${thread}`, async () => void ran.push(name))
        seen[name]++
      },
    })
    const hooked: unknown[] = []
    const board = testBoard({
      watch: {
        review: reviewer('review'),
        other: reviewer('other'),
        flaky: {
          tail: 'firehose',
          run: async ({ event, once }) => {
            if (event.message?.re !== null) return
            await once(`start:${event.message.id}`, async () => 'started')
            throw new Error('sandbox setup failed')
          },
          failed: async ({ event, once }) => {
            hooked.push(await once(`start:${event.message!.id}`, async () => 'from the hook'))
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'review #12' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'and again' })
    const watches = board.servers.at(-1)!
    await vi.waitFor(async () => {
      await board.skipHold(watches, 'watch:flaky')
      await watches.drain('watch:flaky')
      expect(hooked).toHaveLength(1)
    })
    await vi.waitFor(() => expect(seen).toEqual({ review: 2, other: 2 }))
    expect(ran.sort(), "each watcher's fn ran once, for both events").toEqual(['other', 'review'])
    expect(hooked, "the failed hook got run's record").toEqual(['started'])
    error.mockRestore()
  })

  it("keeps posts beside fn on the run's count, and another handle's inside fn on its own", async () => {
    let runs = 0
    let finished = false
    let inside: string | undefined
    const app: ReturnType<typeof testBoard> = testBoard({
      watch: {
        w: {
          tail: 'firehose',
          run: async ({ event, board, once }) => {
            if (event.message?.re !== null) return
            const root = event.message.id
            await Promise.all([
              once('k', async () => {
                await board.reply(root, 'A')
                inside = (await app.as('hook').reply(root, { text: 'C', id: 'd1' })).id
              }),
              board.reply(root, 'B'),
            ])
            if (++runs === 1) throw new Error('cut short after once')
            await board.reply(root, 'D')
            finished = true
          },
        },
      },
    })
    const julian = caller(app.fetch, await personToken(), { 'x-board-handle': 'julian' })
    const root = (await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })).body.message
    const watches = app.servers.at(-1)!
    await vi.waitFor(async () => {
      await app.skipHold(watches, 'watch:w')
      await watches.drain('watch:w')
      expect(finished).toBe(true)
    })
    expect((await repliesOf(julian, root.id)).map(([text]) => text).sort(), 'each reply landed once').toEqual(['A', 'B', 'C', 'D'])
    expect((await app.as('hook').reply(root.id, { text: 'C', id: 'd1' })).id, "the handle's post outside fn").toBe(inside)
  })

  it('returns the JSON of what fn returned on a miss and a hit alike, and checks its key and size', async () => {
    const ran: string[] = []
    const got: Record<string, unknown> = {}
    const board = testBoard({
      watch: {
        w: {
          tail: 'firehose',
          run: async ({ once }) => {
            const at = () =>
              once('at', async () => {
                ran.push('at')
                return { at: new Date(0) } as unknown as Json
              })
            got.miss = await at()
            got.hit = await at()
            const nothing = () => once('nothing', async () => void ran.push('nothing'))
            got.nothing = [await nothing(), await nothing()]
            got.big = await once('big', async () => 'x'.repeat(16_384)).catch((error: Error) => error.message)
            got.small = await once('big', async () => {
              ran.push('big')
              return 'an ID'
            })
            got.keys = await Promise.all(['', 'a\u0000b', 'k'.repeat(201)].map((key) => once(key, async () => void ran.push(key)).catch((error: Error) => error.message)))
            got.done = true
          },
        },
      },
    })
    const julian = caller(board.fetch, await personToken(), { 'x-board-handle': 'julian' })
    await julian('POST', '/messages', { channel: 'firehose', text: 'export is broken' })
    await vi.waitFor(() => expect(got.done).toBe(true))
    expect(got.miss).toStrictEqual({ at: '1970-01-01T00:00:00.000Z' })
    expect(got.hit).toStrictEqual(got.miss)
    expect(got.nothing).toStrictEqual([undefined, undefined])
    expect(got.big).toBe('once big: its result is 16386 bytes as JSON, over 16384: return an ID')
    expect(got.small, 'an oversized result recorded nothing').toBe('an ID')
    expect(got.keys).toEqual(['once: key is empty', 'once: key has a NUL character or a lone surrogate', 'once: key is over 200 characters'])
    expect(ran, 'fn ran once per key it recorded, and never for a bad key').toEqual(['at', 'nothing', 'big'])
  })
})
