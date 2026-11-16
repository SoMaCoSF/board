import type { NextConfig } from "next";

const config: NextConfig = {
  // The runner is read from disk when a campaign's first sandbox is built, so the deployment has to carry it.
  outputFileTracingIncludes: { "/*": ["./sandbox/*.ts"] },
};

export default config;
