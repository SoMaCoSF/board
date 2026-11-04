import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: {
      // `@vercel/board` and `@vercel/board/backend-http` have a `node` build, which finds boards in the environment
      // and serves them, and a default one with nothing that needs Node, for browsers.
      index: 'src/server/index.default.ts',
      'index.node': 'src/server/index.ts',
      access: 'src/access/index.ts',
      conformance: 'src/conformance/index.ts',
      'backend-a2': 'src/backend-a2/index.ts',
      'backend-a2/contract': 'src/contract/index.ts',
      'backend-a2/blob-vercel': 'src/blob/vercel.ts',
      'backend-a2/store-postgres': 'src/store/postgres.ts',
      'backend-a2/store-redis': 'src/store/redis.ts',
      'backend-a2/store-redis-http': 'src/store/redis-http.ts',
      'backend-a2/store-sqlite': 'src/store/sqlite.ts',
      'backend-a2/store-memory': 'src/store/memory.ts',
      'backend-a2/scheduler-vercel': 'src/scheduler/vercel.ts',
      'backend-a2/scheduler-qstash': 'src/scheduler/qstash.ts',
      'backend-a2/scheduler-local': 'src/scheduler/local.ts',
      'backend-http': 'src/backend-http/index.default.ts',
      'backend-http.node': 'src/backend-http/index.ts',
      'backend-vercel': 'src/backend-vercel/index.default.ts',
      'backend-vercel.node': 'src/backend-vercel/index.ts',
      sync: 'src/sync/index.ts',
      'sync-chat-sdk': 'src/sync/chat-sdk.ts',
      'sync-slack': 'src/sync/slack.ts',
      'sync-github': 'src/sync/github.ts',
      'sync-linear': 'src/sync/linear.ts',
      cli: 'src/cli/bin.ts',
      // `@vercel/board/cli`: the CLI for another one to embed, as `vercel board`, without `serve` or `inspect`.
      'cli-embedded': 'src/cli/embedded.ts',
      // `@vercel/board/cli/commands`: the CLI's commands as data, for a host to render, with no imports.
      'cli-commands': 'src/cli/commands.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // A module one entry shares with a lazily loaded chunk stays in a chunk of its own: merged
    // into the entry, it would load that entry (the CLI, say) wherever the chunk loads.
    inputOptions: { experimental: { chunkOptimization: false } },
    dts: true,
    // A2 is inlined: what board runs of it ships in dist, its types too, so installing board installs no
    // experimental-a2, and nothing else from node_modules is.
    deps: {
      alwaysBundle: [/^experimental-a2(\/|$)/],
      onlyBundle: [/^experimental-a2(\/|$)/],
      dts: { alwaysBundle: [/^experimental-a2(\/|$)/] },
    },
    clean: ['dist/*', '!dist/inspect'],
  },
  // `vb inspect`'s page: one prebuilt file, React included, so installing the
  // package installs no UI dependencies.
  {
    entry: { app: 'src/inspect/app/main.tsx' },
    outDir: 'dist/inspect',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    dts: false,
    clean: true,
    hash: false,
    fixedExtension: false,
    outExtensions: () => ({ js: '.js' }),
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    define: { 'process.env.NODE_ENV': '"production"' },
  },
])
