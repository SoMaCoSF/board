import { redisHttp } from "experimental-a2/store-redis-http";
import { vercelQueues } from "experimental-a2/scheduler-vercel";

// The A2 store and queue the board and its agents share: Helper's sessions live next to the board's
// log, and the board's scheduler route serves both. Locally there's no VERCEL_ENV, so the store is
// A2's own default (SQLite at .a2/dev.db), which every A2 server in the process shares.
const env = process.env.VERCEL_ENV;

export const store = env
  ? redisHttp({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
      // One Redis serves every environment: a preview never touches production's log.
      // `-2` since A2 0.17 changed its Redis layout; the log under `vboard-factory` was copied over.
      keyPrefix: env === "production" ? "vboard-factory-2" : `vboard-factory-2:${env}`,
    })
  : undefined;

export const queue = vercelQueues({ topic: "vboard-factory" });
