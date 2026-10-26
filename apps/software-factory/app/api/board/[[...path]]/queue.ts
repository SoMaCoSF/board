/**
 * The queue's options for an environment. By default Vercel Queues pins each message to the deployment that sent
 * it, and each schedule send arms the next one there, so a repeating schedule stayed on the deployment it was made
 * on long after a deploy: the sitreps kept running the code from before the repo moved to vercel-labs/board, whose
 * sandboxes asked for git credentials to the old repo and never started (board thread #690). Production unpins, so
 * its timers and watcher work reach whichever deployment is current. A preview keeps the pin: its store is its own,
 * and unpinned, its messages could land on production.
 */
export const queueOptions = (env: string | undefined) => ({
  topic: "vboard-factory",
  ...(env === "production" ? { deploymentId: null } : {}),
});
