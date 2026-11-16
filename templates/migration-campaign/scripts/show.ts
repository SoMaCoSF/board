// A campaign as the board has it, in the terminal: node --env-file=.env.local scripts/show.ts <slug> [task-id]
// With a task's ID, its thread too: what the agent said, what failed, and the patch it attached.
import { team } from "../lib/board.ts";
import { history, snapshot } from "../lib/campaign.ts";

const [slug, id] = process.argv.slice(2);
const now = slug ? await snapshot(slug) : null;
if (!now) {
  console.error(slug ? `the board has no campaign ${slug}` : "usage: scripts/show.ts <slug> [task-id]");
  process.exit(1);
}

const { campaign, counts, tasks } = now;
console.log(`${campaign.slug}  ${campaign.phase}  ${campaign.title}`);
console.log(`  ${counts.completed}/${tasks.length} completed, ${counts.claimed} working, ${counts.blocked} held, ${counts.canceled} canceled  $${now.cost.toFixed(4)}  ${now.tokens} tokens\n`);
for (const task of tasks) {
  console.log(`  ${task.state.padEnd(9)}  ${task.id}  ${task.title}  $${task.cost.toFixed(4)}`);
  const about = task.result ?? task.held?.reason;
  if (about) console.log(`             ${about.slice(0, 160)}`);
}

if (id) {
  const { root, replies } = await history(campaign.slug, id);
  console.log(`\n${root.text}\n`);
  for (const reply of replies) {
    console.log(`[${reply.author} ${reply.at.slice(11, 19)}] ${reply.text}`);
    for (const file of reply.files) console.log(`\n--- ${file.name} ---\n${await (await team().download(file.id)).text()}`);
    console.log();
  }
}
