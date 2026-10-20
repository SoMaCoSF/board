import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: {
      index: 'src/server/index.ts',
      client: 'src/client/index.ts',
      'client.node': 'src/client/index.node.ts',
      'adapter-slack': 'src/sync/slack.ts',
      'adapter-github': 'src/sync/github.ts',
      'adapter-kapso': 'src/sync/kapso.ts',
      'adapter-vercel-blob': 'src/blob/vercel.ts',
      contract: 'src/contract/index.ts',
      sync: 'src/sync/index.ts',
      'sync.chat': 'src/sync/chat-provider.ts',
      'store-postgres': 'src/store/postgres.ts',
      'store-redis': 'src/store/redis.ts',
      'store-redis-http': 'src/store/redis-http.ts',
      'store-sqlite': 'src/store/sqlite.ts',
      'store-memory': 'src/store/memory.ts',
      'scheduler-vercel': 'src/scheduler/vercel.ts',
      'scheduler-qstash': 'src/scheduler/qstash.ts',
      cli: 'src/cli/main.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
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
