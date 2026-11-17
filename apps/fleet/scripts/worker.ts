// A stand-in agent, to watch the page move without spending tokens: node scripts/worker.ts [name]
// It does what JOIN.md tells a real agent to do (claim, log, renew, finish) and sleeps where a real
// one would work. STEP_MS sets how long each step takes (3 s by default). Stop it with Ctrl-C.
import { FLEET, FROM, team } from "../lib/board.ts";
import { claim, finish, renew } from "../lib/queue.ts";

const name = process.argv[2] ?? `worker-${Math.random().toString(36).slice(2, 6)}`;
const board = team().as(name);
const me = await board.me();
const step = Number(process.env.STEP_MS ?? 3_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Whose tasks it takes: FLEET_FROM's, or its own person's when that's unset.
const from = FROM.length > 0 ? FROM : [me.principal];

console.log(`${me.handle ?? name} is working ${FLEET}`);
for (;;) {
  const { tasks, cursor } = await board.tasks.list({ channel: FLEET, state: "ready" });
  // A task text is instructions: take them only from whom the fleet trusts, and never review your own work.
  const fit = tasks.filter(({ message }) => message.task && from.includes(message.task.owner) && message.task.by !== me.actor);
  if (fit.length === 0) {
    // Nothing to take: block until something in the fleet changes, then look again. Waiting from
    // where the list stood catches what landed while this loop was looking.
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
