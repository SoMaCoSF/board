// Copies the repo's agent skill into skills/board, so the package ships it: a project links
// node_modules/@vercel/board/skills/board instead of installing it. Run by `pnpm build`.
import { cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'skills'), { recursive: true, force: true })
cpSync(join(root, '..', '..', 'skills', 'board'), join(root, 'skills', 'board'), { recursive: true })
