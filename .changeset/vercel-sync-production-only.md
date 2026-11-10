---
'@vercel/board': minor
---

On Vercel's board, only production registers `sync`. Vercel's API gives each sync key on a board one owner, and a preview runs production's code, so whichever deployment first used a new board took `slack`, and the other's registration, its watchers included, failed with 409 `sync_key_taken`. A deployment in any other environment (a preview, a custom environment, `next dev` with the project's OIDC token) now registers its watchers without its sync entries, and syncs nothing. To sync from one too, name its environment:

```ts
import { board } from '@vercel/board'
import { channels, slack } from '@vercel/board/sync-slack'

const team = board({
  sync: { slack: slack('slack/acme', channels({ '#prs': 'prs' })) },
  syncEnvironments: ['production', 'preview'],
})
```
