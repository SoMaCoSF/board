import type { NextConfig } from "next";

const config: NextConfig = {
  // Pi's loop, which Helper runs on (A2 imports it when Helper's first turn starts): its wasm doesn't bundle.
  serverExternalPackages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
  // The skills and extensions the board route writes into Pi's sandbox (agent.ts reads them at runtime).
  outputFileTracingIncludes: { "/api/board/[[...path]]": ["./skills/**/*", "./extensions/**/*"] },
  // Every docs page as authored, for agents and "copy as markdown": /quickstart.md.
  // The board's routes under /api never are.
  rewrites: async () => [{ source: "/:path((?!api/).+)\\.md", destination: "/raw/:path" }],
};

export default config;
