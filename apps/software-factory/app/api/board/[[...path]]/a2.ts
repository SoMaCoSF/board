import { redisHttp } from "vboard/store-redis-http";
import { vercelQueues } from "vboard/scheduler-vercel";

// The factory's store and queue, shared by the board and Pi's token refreshes (`tokens.ts`): A2's log and
// the board's tables on the project's Upstash, under one prefix. Locally there's no VERCEL_ENV, so it's
// SQLite at .a2/dev.db.
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

export const queues = vercelQueues({ topic: "vboard-factory" });
