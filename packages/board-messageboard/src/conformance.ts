// Runs `vb conformance`'s checks against a board on api-messageboard:
// MESSAGEBOARD_URL=… MESSAGEBOARD_TOKEN=… MESSAGEBOARD_TEAM_ID=… node src/conformance.ts
import { board } from '@vercel/board'
import { conformance } from '@vercel/board/conformance'
import { messageboard } from './index.ts'

function env(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`set ${name}`)
  }
  return value
}

const backend = messageboard({
  url: env('MESSAGEBOARD_URL'),
  token: env('MESSAGEBOARD_TOKEN'),
  teamId: env('MESSAGEBOARD_TEAM_ID'),
  ...(process.env.MESSAGEBOARD_BOARD_ID ? { boardId: process.env.MESSAGEBOARD_BOARD_ID } : {}),
})
const report = await conformance(board({ backend }))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  let group = ''
  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group
      console.log(`\n${group}`)
    }
    console.log(`  ${check.status.padEnd(7)}  ${check.name}`)
    if (check.detail) {
      console.log(`           ${check.detail}`)
    }
  }
  const count = (status: string) => report.checks.filter((check) => check.status === status).length
  console.log(`\n${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`)
}
process.exitCode = report.ok ? 0 : 1
