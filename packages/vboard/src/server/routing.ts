import type { RouteName } from '../api/routes.ts'
import { badRequest } from './errors.ts'

export type Match = { name: RouteName; base: string; id?: number; param?: string }

// Most specific first; each route is matched as a suffix of the request path.
const PATTERNS: { method: string; name: RouteName; pattern: RegExp }[] = [
  { method: 'POST', name: 'identityLink', pattern: /\/identity\/link$/ },
  { method: 'POST', name: 'identityCheck', pattern: /\/identity\/check$/ },
  { method: 'POST', name: 'identityUnlink', pattern: /\/identity\/unlink$/ },
  { method: 'GET', name: 'identity', pattern: /\/identity$/ },
  { method: 'POST', name: 'edit', pattern: /\/messages\/(\d+)\/edit$/ },
  { method: 'POST', name: 'delete', pattern: /\/messages\/(\d+)\/delete$/ },
  { method: 'POST', name: 'react', pattern: /\/messages\/(\d+)\/reactions$/ },
  { method: 'POST', name: 'label', pattern: /\/messages\/(\d+)\/labels$/ },
  { method: 'POST', name: 'sync', pattern: /\/messages\/(\d+)\/sync$/ },
  { method: 'POST', name: 'typing', pattern: /\/messages\/(\d+)\/typing$/ },
  { method: 'GET', name: 'message', pattern: /\/messages\/(\d+)$/ },
  { method: 'GET', name: 'messages', pattern: /\/messages$/ },
  { method: 'POST', name: 'post', pattern: /\/messages$/ },
  { method: 'GET', name: 'threads', pattern: /\/threads$/ },
  { method: 'POST', name: 'cancelSchedule', pattern: /\/schedules\/s?(\d+)\/cancel$/ },
  { method: 'GET', name: 'schedules', pattern: /\/schedules$/ },
  { method: 'POST', name: 'schedule', pattern: /\/schedules$/ },
  { method: 'GET', name: 'channels', pattern: /\/channels$/ },
  { method: 'GET', name: 'actors', pattern: /\/actors$/ },
  { method: 'GET', name: 'events', pattern: /\/events$/ },
  { method: 'GET', name: 'me', pattern: /\/me$/ },
  { method: 'GET', name: 'inbox', pattern: /\/inbox\/([A-Za-z0-9_-]+)$/ },
  { method: 'POST', name: 'redrive', pattern: /\/stuck\/redrive$/ },
  { method: 'GET', name: 'stuck', pattern: /\/stuck$/ },
  { method: 'GET', name: 'sourceRead', pattern: /\/sources\/([A-Za-z0-9_-]+)\/read$/ },
  { method: 'POST', name: 'webhook', pattern: /\/webhooks\/([A-Za-z0-9_-]+)$/ },
  { method: 'GET', name: 'avatar', pattern: /\/avatars\/([a-z0-9-]+)$/ },
  { method: 'GET', name: 'openapi', pattern: /\/openapi\.json$/ },
  { method: 'POST', name: 'upload', pattern: /\/attachments$/ },
  { method: 'GET', name: 'attachment', pattern: /\/attachments\/([A-Za-z0-9_-]+)$/ },
  { method: 'GET', name: 'watchers', pattern: /\/watchers$/ },
  { method: 'POST', name: 'register', pattern: /\/watchers$/ },
  { method: 'POST', name: 'deliver', pattern: /\/deliveries\/([A-Za-z][A-Za-z0-9-]{0,31})$/ },
]

const NUMERIC = new Set<RouteName>(['edit', 'delete', 'react', 'label', 'sync', 'typing', 'message', 'cancelSchedule'])

export function route(method: string, pathname: string, basePath?: string): Match | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (basePath !== undefined) {
    const base = basePath.replace(/\/+$/, '')
    if (path !== base && !path.startsWith(`${base}/`)) return null
    const rest = path.slice(base.length) || '/'
    if (rest === '/') return method === 'GET' ? { name: 'discovery', base } : null
    for (const candidate of PATTERNS) {
      const found = rest.match(new RegExp(`^${candidate.pattern.source}`))
      if (candidate.method === method && found) return withParam(candidate.name, base, found[1])
    }
    return null
  }
  for (const candidate of PATTERNS) {
    if (candidate.method !== method) continue
    const found = path.match(candidate.pattern)
    if (found) return withParam(candidate.name, path.slice(0, found.index), found[1])
  }
  return method === 'GET' ? { name: 'discovery', base: path === '/' ? '' : path } : null
}

const withParam = (name: RouteName, base: string, param: string | undefined): Match =>
  param === undefined ? { name, base } : NUMERIC.has(name) ? { name, base, id: Number(param) } : { name, base, param }

export function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    out[key] = values.length > 1 ? values : values[0]!
  }
  return out
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest('request body is not valid JSON')
  }
}

