import {
  deliverSchedulerAppend,
  type A2Scheduler,
  type DrainableServer,
  type SchedulerAppendTask,
} from 'experimental-a2/server'

/** A queue that drains right away and holds timers until `fire` delivers the due ones. */
export function fakeQueue() {
  let servers: DrainableServer[] = []
  const timers: SchedulerAppendTask[] = []
  const drain = (contract: string, sessionId: string) =>
    setTimeout(() => void servers.find((s) => s.contract.name === contract)?.drain(sessionId), 0)
  const scheduler: A2Scheduler = {
    schedule: async (task) => {
      if (task.kind === 'drain') drain(task.contract, task.sessionId)
      // vboard never clears a session, so the only other task is a timer.
      else if (task.kind === 'append' && !timers.some((t) => t.id === task.id)) timers.push(task)
    },
    handler: (...mounted) => {
      servers = mounted
      return async () => new Response(null, { status: 204 })
    },
  }
  return {
    scheduler,
    timers,
    /** Delivers every timer due by now, as the queue would. */
    async fire() {
      const due = timers.filter((t) => t.dueAt <= Date.now())
      for (const task of due) {
        timers.splice(timers.indexOf(task), 1)
        await deliverSchedulerAppend(servers.find((s) => s.contract.name === task.contract)!, task)
      }
      return due.length
    },
  }
}
