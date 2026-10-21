import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NetworkPolicyMatcher, NetworkPolicyRule } from '@vercel/sandbox'
import { describe, expect, it } from 'vitest'
import { routes } from '../src/api/routes.ts'
import { vercelProject } from '../src/access/index.ts'
import { boardRules, type BoardRulesOptions } from '../src/sandbox/index.ts'
import { tmp, useBoard, vb } from './cli-harness.ts'
import { deploymentToken, testBoard } from './harness.ts'
import { serve } from './http.ts'
import { fakeQueue } from './queue.ts'

useBoard()

const test = (matcher: NetworkPolicyMatcher, value: string) =>
  'exact' in matcher ? value === matcher.exact : new RegExp((matcher as { regex: string }).regex).test(value)

/** As a Vercel Sandbox's proxy reads a rule: every dimension it names matches, header names in any case. */
function matches({ match }: NetworkPolicyRule, method: string, path: string, headers: Headers) {
  if (!match) return true
  if (match.method && !match.method.includes(method)) return false
  if (match.path && !test(match.path, path)) return false
  return (match.headers ?? []).every(({ key, value }) => [...headers].some(([k, v]) => (!key || test(key, k)) && (!value || test(value, v))))
}

/** The sandbox's proxy for one host: the first rule that matches sets headers or answers, and nothing else is touched. */
function proxy(rules: () => NetworkPolicyRule[], upstream: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    const rule = rules().find((rule) => matches(rule, request.method, new URL(request.url).pathname, request.headers))
    if (rule?.response)
      return new Response(rule.response.body, { status: rule.response.statusCode, headers: { 'content-type': rule.response.contentType! } })
    const headers = new Headers(request.headers)
    for (const transform of rule?.transform ?? []) for (const [name, value] of Object.entries(transform.headers ?? {})) headers.set(name, value)
    return upstream(new Request(request, { headers }))
  }
}

const OPTIONS: BoardRulesOptions = { url: 'https://acme.test/api/board', token: 'real', profile: 'clever-lemur' }

/** What the policy does with a request: adds the credentials, answers it from the proxy, or lets it pass as it is. */
function outcome(options: BoardRulesOptions, method: string, path: string, headers: Record<string, string> = {}) {
  const [rules] = Object.values(boardRules(options))
  const rule = rules!.find((rule) => matches(rule, method, path, new Headers(headers)))
  return rule?.transform ? 'credentialed' : rule?.response ? 'blocked' : 'passed'
}

describe('boardRules', () => {
  it('credentials the routes vb uses, and answers every other route of the board itself', () => {
    expect(Object.keys(boardRules(OPTIONS))).toEqual(['acme.test'])
    const sample = (path: string) => `/api/board${path.replace(/:\w+/g, '12')}`
    const reached = Object.entries(routes).map(([name, route]) => [name, outcome(OPTIONS, route.method, sample(route.path))])
    expect(reached.filter(([, result]) => result === 'credentialed').map(([name]) => name)).toEqual([
      'discovery', 'me', 'channels', 'actors', 'messages', 'message', 'threads', 'post', 'edit', 'delete', 'react', 'label',
      'sync', 'typing', 'schedule', 'schedules', 'cancelSchedule', 'posted', 'events', 'upload', 'attachment',
    ])
    expect(reached.filter(([, result]) => result === 'passed')).toEqual([])
  })

  it('never credentials a path outside the board, or one the board would route elsewhere', () => {
    expect(outcome(OPTIONS, 'POST', '/api/a2/scheduler')).toBe('passed')
    expect(outcome(OPTIONS, 'GET', '/sync/slack.md')).toBe('passed')
    expect(outcome(OPTIONS, 'GET', '/api/boards/me')).toBe('passed')
    // The proxy matches a `\` as `%5C`; the board's URL parser reads `\` as `/`.
    for (const path of [
      '/api/board/messages/a%5C..%5C..%5Csources%5Cslack%5Cread',
      '/api/board/messages/a%5c..%5c..%5cstuck',
      '/api/board/messages/a%2F..%2F..%2Fstuck',
      '/api/board/messages/12/../../stuck',
      '/api/board/me/',
    ])
      expect(outcome(OPTIONS, 'GET', path), path).toBe('blocked')
    expect(outcome(OPTIONS, 'GET', '/api/board/posts/caf%C3%A9%3A1')).toBe('credentialed')
  })

  it('credentials only the placeholder when given one', () => {
    const options = { ...OPTIONS, placeholder: 'from-the-network-policy' }
    expect(outcome(options, 'GET', '/api/board/me', { authorization: 'Bearer from-the-network-policy' })).toBe('credentialed')
    expect(outcome(options, 'GET', '/api/board/me', { authorization: 'Bearer something-else' })).toBe('blocked')
    expect(outcome(options, 'GET', '/api/board/me')).toBe('blocked')
  })

  it('throws on what the board would refuse, or a mount it could route around', () => {
    expect(() => boardRules({ ...OPTIONS, url: 'https://acme.test/api/inbox' })).toThrow('a segment of its routes')
    expect(() => boardRules({ ...OPTIONS, profile: '9lives' })).toThrow('profile names start with a letter')
    expect(() => boardRules({ ...OPTIONS, avatar: 'http://acme.test/pi.png' })).toThrow('avatars must be https URLs')
    expect(() => boardRules({ ...OPTIONS, scope: { 'dev/*': ['read'] } })).toThrow('write dev/ for dev and its subtree')
    expect(() => boardRules({ ...OPTIONS, headers: { 'X-Board-Profile': 'mallory' } })).toThrow("can't set X-Board-Profile")
  })

  it("runs vb through the policy as one pinned identity, narrowed by its scope, and keeps the board's webhooks out of reach", async () => {
    const queue = fakeQueue()
    const board = testBoard({ url: undefined, scheduler: queue.scheduler, access: [vercelProject({ project: 'prj_factory', can: 'all' })] })
    const reached: string[] = []
    let rules: NetworkPolicyRule[] = []
    const server = await serve(
      proxy(
        () => rules,
        (request) => (reached.push(`${request.method} ${new URL(request.url).pathname}`), board.fetch(request)),
      ),
    )
    try {
      const url = `${server.origin}/api/board`
      const token = await deploymentToken('factory', 'prj_factory', 'production', { audience: url })
      ;[rules] = Object.values(
        boardRules({ url, token, profile: 'clever-lemur', session: 'thread-7', scope: { 'dev/': ['read', 'post', 'react', 'label'] }, placeholder: 'from-the-network-policy' }),
      ) as [NetworkPolicyRule[]]
      const sandbox = { VBOARD_URL: url, VBOARD_TOKEN: 'from-the-network-policy' }
      const run = (args: string[]) => vb(args, sandbox)

      expect(JSON.parse((await run(['whoami', '--json'])).stdout)).toMatchObject({
        handle: 'factory/clever-lemur', profile: 'clever-lemur', session: 'thread-7', can: { 'dev/': ['read', 'post', 'react', 'label'] },
      })
      const file = join(await tmp('vboard-sandbox-'), 'trace.txt')
      await writeFile(file, 'stack trace')
      const root = (await run(['post', 'dev', 'the fix is up', '--as', 'mallory', '--attach', file])).stdout.trim()
      const reply = (await run(['reply', root, 'and its test'])).stdout.trim()
      for (const args of [['react', root, 'eyes'], ['label', root, 'kind=bug'], ['edit', reply, 'and its tests'], ['typing', root], ['channels'], ['actors']])
        expect(await run(args), args.join(' ')).toMatchObject({ code: 0, stderr: '' })
      const [message, answer] = (await run(['read', root, '--json'])).stdout.trim().split('\n').map((line) => JSON.parse(line))
      expect(message).toMatchObject({ labels: { kind: 'bug' }, by: { profile: 'clever-lemur', session: 'thread-7' } })
      expect(answer).toMatchObject({ text: 'and its tests', by: { profile: 'clever-lemur' } })
      expect(await run(['download', message.attachments[0].id, '-'])).toMatchObject({ code: 0, stdout: 'stack trace' })
      const { id: scheduled } = JSON.parse((await run(['schedule', 'dev', 'check on it', '--in', '1h', '--json'])).stdout)
      expect((await run(['schedules'])).stdout).toContain('check on it')
      expect((await run(['schedule', 'cancel', `s${scheduled}`])).stdout).toBe(`canceled s${scheduled}\n`)
      expect(await run(['wait', 'dev', '--timeout', '1s'])).toMatchObject({ code: 124, stderr: 'timed out\n' })

      expect(await run(['post', 'ops', 'outside its scope'])).toMatchObject({ code: 1, stderr: "error: this token can't post in ops\n" })
      expect(await run(['stuck'])).toMatchObject({ code: 1, stderr: "error: this sandbox's network policy doesn't let it use this route\n" })
      const webhook = await fetch(`${url}/webhooks/slack`, { method: 'POST', headers: { authorization: 'Bearer from-the-network-policy' }, body: '{}' })
      expect(webhook.status).toBe(403)
      expect(reached.filter((request) => /webhooks|stuck/.test(request))).toEqual([])
    } finally {
      await server.close()
    }
  }, 120_000)
})
