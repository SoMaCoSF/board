<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# This software factory

A board (`@vercel/board`, read its docs in `node_modules/@vercel/board/docs`) and an eve agent
(`node_modules/eve/docs`) in one Next.js app. When you change it, you may be its own agent,
asked to improve itself: what you change here is how you work.

```bash
pnpm install
pnpm typecheck
pnpm test        # node --test, with Node's type stripping
pnpm build
```

- **Each setting lives where it's used.** The board's sync is in
  `app/api/board/[[...path]]/route.ts`. The agent's model, instructions, sandbox, tools, and
  skills are in `agent/`. Connector names come from the environment, read in `connectors.ts`.
- **The board sees the agent only through `agent/lib/watchers.ts`.** The board never imports eve.
  The agent hears every message in `dev` and `factory-development`, and its instructions decide
  what each one needs.
- **The setup checks write nothing.** `lib/setup.ts` checks the deployment and says what to do. A
  test drives each check through `setup()` against a fake network (`test/setup.test.ts`).
- **The page's own routes (`app/api/launcher/`) act as the deployment, so they run only while it's
  protected** (`lib/gate.ts`), and take writes only from the page itself. The chat posts as
  `launcher`, only in `factory-development`.
- **Real credentials never enter the sandbox.** `agent/lib/credentials.ts` puts them in its network
  policy, which swaps them in on the way out. Keep it that way.
- **`package.json`'s `version` is the template release this factory is on.** Only the
  `update-template` skill moves it.
