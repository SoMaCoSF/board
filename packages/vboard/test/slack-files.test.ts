import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createSlackAdapter } from '@chat-adapter/slack'
import { slack, slackFileName } from '../src/sync/slack.ts'

/**
 * The real Slack adapter, single-workspace like the software factory (an async
 * bot token, as Vercel Connect gives it), downloading through a fake transport.
 */
function slackWith(served: Uint8Array, extra: Record<string, unknown> = {}) {
  const requests: { url: string; authorization: string | undefined }[] = []
  const adapter = createSlackAdapter({
    signingSecret: 'secret',
    botToken: async () => 'xoxb-test',
    ...extra,
    fileTransport: async (url: URL, _signal: AbortSignal, headers: Record<string, string>) => {
      requests.push({ url: url.href, authorization: headers.authorization })
      return Object.assign(Readable.from([Buffer.from(served)]), {
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(served.byteLength) },
      })
    },
  } as Parameters<typeof createSlackAdapter>[0])
  const provider = slack({ adapter, client: async () => ({ conversations: { list: async () => ({}), info: async () => ({}), join: async () => ({}) } }), channels: {} })
  return { provider, requests }
}

describe('files from Slack', () => {
  it('downloads a file with the bot token in a single-workspace app, though Slack says which team it came from', async () => {
    const png = new Uint8Array([137, 80, 78, 71])
    const { provider, requests } = slackWith(png)
    // What a Slack message event carries: the file's private URL and the event's team.
    const url = 'https://files.slack.com/files-pri/T1-F1/shot.png'
    const data = await provider.fetchFile({ type: 'image', name: 'shot.png', mimeType: 'image/png', size: 4, url, fetchMetadata: { url, teamId: 'T1' } })
    expect(data && [...data]).toEqual([...png])
    expect(requests).toEqual([{ url, authorization: 'Bearer xoxb-test' }])
  })

  it('keeps the team on a file in an app that also installs through OAuth, so each team uses its own token', async () => {
    const { provider, requests } = slackWith(new Uint8Array([1]), { clientId: 'client', clientSecret: 'shh' })
    const url = 'https://files.slack.com/files-pri/T2-F2/other.png'
    await expect(provider.fetchFile({ type: 'image', name: 'other.png', url, fetchMetadata: { url, teamId: 'T2' } })).rejects.toThrow(/Installation not found for team T2/)
    expect(requests).toEqual([]) // never sent with the default bot token
  })
})

describe('files to Slack', () => {
  it('names a text file so Slack previews it instead of offering a binary download', () => {
    expect(slackFileName('deepsec.log', 'text/plain')).toBe('deepsec.log.txt')
    expect(slackFileName('events.ndjson', 'application/x-ndjson')).toBe('events.ndjson.txt')
    expect(slackFileName('Makefile', 'text/plain')).toBe('Makefile.txt')
    expect(slackFileName('test-run.txt', 'text/plain')).toBe('test-run.txt')
    expect(slackFileName('README.MD', 'text/markdown')).toBe('README.MD')
    expect(slackFileName('data.json', 'application/json')).toBe('data.json')
    expect(slackFileName('shot.png', 'image/png')).toBe('shot.png')
    expect(slackFileName('blob.bin', 'application/octet-stream')).toBe('blob.bin')
    expect(slackFileName('unknown.log')).toBe('unknown.log')
  })
})
