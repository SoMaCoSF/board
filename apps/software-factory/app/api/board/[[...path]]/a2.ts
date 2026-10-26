import { redisHttp } from "vboard/backend-a2/store-redis-http";
import { vercelQueues } from "vboard/backend-a2/scheduler-vercel";
import { queueOptions } from "./queue.ts";

// The factory's store and queue, shared by the board and Pi's token refreshes (`tokens.ts`): A2's log and
// the board's tables on the project's Upstash, under one prefix. Locally there's no VERCEL_ENV, so it's
// SQLite at .a2/dev.db, loaded only there.
const env = process.env.VERCEL_ENV;

export const store = env
  ? redisHttp({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
      // One Redis serves every environment: a preview never touches production's log.
      // `-3` since A2 0.22 renamed every key and refuses a prefix 0.21 wrote: the log started empty here.
      keyPrefix: env === "production" ? "vboard-factory-3" : `vboard-factory-3:${env}`,
    })
  : (await import("vboard/backend-a2/store-sqlite")).sqlite();

export const queues = vercelQueues(queueOptions(env));
