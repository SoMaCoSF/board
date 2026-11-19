// Local server for the mission-control page: serves `public/` and answers
// `/api/activity` from the compiled `_lib` (run `pnpm build` first). With no
// board connected, the snapshot's data source is the fixture set.
//
//   pnpm build && pnpm dev        # http://127.0.0.1:4173
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const publicDir = join(root, 'public')
const port = Number(process.env.PORT || 4173)

const { getActivity } = await import(join(root, 'dist/_lib/activity.js'))

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === '/api/activity') {
    try {
      const snapshot = await getActivity()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(snapshot))
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
    return
  }
  const path = normalize(join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname))
  if (!path.startsWith(publicDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`mission control at http://127.0.0.1:${port}`)
})
