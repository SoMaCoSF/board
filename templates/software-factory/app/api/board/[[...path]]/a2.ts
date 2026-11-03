import { vercelQueues } from "@vercel/board/backend-a2/scheduler-vercel";
import { redisHttp } from "@vercel/board/backend-a2/store-redis-http";

// The board's log and tables. On Vercel they're in the project's Upstash Redis, under a prefix per
// environment, so a preview never touches production's. Locally there's no VERCEL_ENV, so it's
// SQLite at .a2/dev.db, loaded only there.
const env = process.env.VERCEL_ENV;

export const store = env
  ? redisHttp({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
      keyPrefix: env === "production" ? "factory" : `factory:${env}`,
    })
  : (await import("@vercel/board/backend-a2/store-sqlite")).sqlite();

// The topic vercel.json's trigger delivers to app/api/a2/scheduler.
export const queues = vercelQueues({ topic: "factory" });
