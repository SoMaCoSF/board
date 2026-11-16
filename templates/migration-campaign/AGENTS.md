<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# This migration campaign

A Next.js app that runs swarms of agents on a board (`@vercel/board`, its docs are in
`node_modules/@vercel/board/docs`) and in Vercel Sandboxes (`@vercel/sandbox`). README.md says what
it does and where each part is.

```bash
pnpm install
pnpm typecheck
pnpm test        # node --test, with Node's type stripping, on a board in memory
pnpm build
```

- **The board is the only state.** A campaign is a thread, its config is that thread's text, its
  phase is a label, and its tasks are threads in `migrate/<slug>`. Nothing is kept in the app, a
  database, or a sandbox that the app needs back. Keep it that way: `reconcile` (`lib/run.ts`) must
  be able to pick any campaign up from the board alone.
- **A task's state is labels, and every change is a compare-and-set** (`lib/queue.ts`). The runner
  takes the same steps with `vb label --if`. Change one and change the other, and keep each label
  filter to one value: Vercel's board indexes only that.
- **The runner's loop is code.** A model decides what to change in a file. It doesn't claim tasks,
  decide it's done, or deliver. Don't move those into a prompt.
- **Real credentials never enter a sandbox.** `lib/sandboxes.ts` puts them in each sandbox's
  network policy, which adds them on the way out. Placeholders go in the environment.
- **`sandbox/` runs in the sandboxes,** on the versions `RUNTIME` pins (`lib/sandboxes.ts`), which
  a test keeps in step with `package.json`. It imports nothing from `lib/` or `app/`. The base
  image is named by a hash of those files, so a change to them builds a new one on the next launch.
- **The page acts as the deployment,** so every action that starts, stops, or spends something
  goes through `guarded` (`app/actions.ts`), which refuses while strangers can reach the
  deployment (`lib/gate.ts`).
- **Tests use sandboxes that are only names** (`fake` in `test/campaign.test.ts`) and a board in
  memory. What they can't cover is the sandboxes themselves: after a change to `lib/sandboxes.ts`
  or `sandbox/runner.ts`, run the sample for real with `pnpm campaign`. It costs about a cent.
