// A stand-in agent, to watch the page move without spending tokens: node scripts/worker.ts [name]
// It does what JOIN.md tells a real agent to do (claim, log, renew, finish) and sleeps where a real
// one would work. STEP_MS sets how long each step takes (3 s by default). Stop it with Ctrl-C.
import type { ThreadSummaryView } from "@vercel/board";
import { FLEET, FROM, team } from "../lib/board.ts";
import { claim, finish, renew } from "../lib/queue.ts";

const name = process.argv[2] ?? `worker-${Math.random().toString(36).slice(2, 6)}`;
const board = team().as(name);
const me = await board.me();
const step = Number(process.env.STEP_MS ?? 3_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Whose tasks it takes: its own person's, and FLEET_FROM's, as `vb tasks claim --ready --from` does.
const from = [me.principal, ...FROM];
// A task's text is instructions: take them only from whom the fleet trusts. Never review your own
// work, and leave a task assigned to another agent to it.
const fits = ({ message }: ThreadSummaryView) =>
  !!message.task && from.includes(message.task.owner) && message.task.by !== me.actor && (message.task.for === null || message.task.for === me.actor);

/** The ready tasks it may take, from every page of them. */
async function ready(): Promise<ThreadSummaryView[]> {
  const fit: ThreadSummaryView[] = [];
  for (let after: string | undefined; ; ) {
    const page = await board.tasks.list({ channel: FLEET, state: "ready", limit: 100, ...(after ? { after } : {}) });
    fit.push(...page.tasks.filter(fits));
    if (page.tasks.length < 100) return fit;
    after = page.cursor;
  }
}

console.log(`${me.handle ?? name} is working ${FLEET}`);
for (;;) {
  // Where the fleet's events stand before it looks, so a wait catches what lands while it looks.
  const { cursor } = await board.messages({ channel: FLEET, limit: 1 });
  const fit = await ready();
  if (fit.length === 0) {
    // Nothing to take: block until something in the fleet changes, then look again.
    await board.wait({ channel: FLEET, after: cursor }, { timeout: "1m" });
    continue;
  }
  const { message } = fit[Math.floor(Math.random() * fit.length)]!;
  let held = await claim(board, message.id);
  if (!held) continue; // someone was first

  const title = message.text.split("\n", 1)[0];
  console.log(`claimed ${message.id}  ${title}`);
  await board.reply(message.id, "[progress] Claimed. Plan: reproduce, change, verify, report.");
  for (const note of ["[progress] Reproduced it. Working on the change.", "[progress] Change made. Verifying."]) {
    await sleep(step);
    // A lost claim means someone took the task over: stop, and settle nothing.
    if (!(held = await renew(held))) break;
    await board.reply(message.id, note);
  }
  if (!held) {
    await board.reply(message.id, "Lost the claim, so stopping here.");
    continue;
  }
  await sleep(step);
  if (!(await finish(held, "complete", "verified"))) continue;
  console.log(`completed ${message.id}`);
  // Half the work asks for a second pair of eyes: a review is a task that needs this one, for another agent.
  if (!title?.startsWith("Review") && Math.random() < 0.5) {
    const { task } = await board.tasks.create(message.channel, { text: `Review: ${title}\n\nCheck ${message.id}'s change holds.`, needs: [message.id] });
    await board.reply(message.id, `Done: verified. Review queued as ${task.id}.`);
  } else {
    await board.reply(message.id, "Done: verified.");
  }
}
