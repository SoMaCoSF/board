// A campaign from the terminal, with no page: node --env-file=.env.local scripts/run.ts [config.json]
// With no file it runs the sample. It does what the page and the cron do between them: launches
// the campaign, reconciles it until it ends, and prints what the board says as it goes. Ctrl-C
// stops the campaign and its sandboxes.
import { readFile } from "node:fs/promises";
import { team } from "../lib/board.ts";
import { snapshot } from "../lib/campaign.ts";
import { parseConfig, SAMPLE } from "../lib/config.ts";
import { begin, change, launch, reconcile } from "../lib/run.ts";

const file = process.argv[2];
const parsed = parseConfig(file ? JSON.parse(await readFile(file, "utf8")) : SAMPLE);
if ("problem" in parsed) {
  console.error(parsed.problem);
  process.exit(2);
}

const board = team();
const campaign = await begin(parsed.config, board);
console.log(`${campaign.slug}  ${campaign.title}`);
console.log(`  ${parsed.config.agents} agents on ${parsed.config.model}, up to $${parsed.config.budgetUsd} and ${parsed.config.minutes}m\n`);

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nstopping…");
  void change(campaign.slug, "stopped", board).finally(() => process.exit(130));
});

const launching = launch(campaign, board);
const seen = new Set<string>();
let last = "";
for (;;) {
  const now = await snapshot(campaign.slug, board);
  if (!now) break;
  for (const entry of now.log) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    console.log(`  ${entry.at.slice(11, 19)}  ${entry.text.split("\n", 1)[0]}`);
  }
  const { counts } = now;
  const line = `  ${now.campaign.phase}  ${counts.completed}/${now.tasks.length} completed, ${counts.claimed} working, ${counts.blocked} held, $${now.cost.toFixed(2)}`;
  if (line !== last) console.log((last = line));
  if (!["preparing", "running", "paused"].includes(now.campaign.phase)) {
    for (const task of now.tasks) console.log(`    ${task.state.padEnd(9)}  ${task.title}  ${task.result ?? task.held?.reason ?? ""}`.trimEnd());
    break;
  }
  if (now.campaign.phase === "running") await reconcile(campaign.slug, board).catch((error: Error) => console.error(`  reconcile: ${error.message}`));
  await new Promise((resolve) => setTimeout(resolve, 8_000));
}
await launching;
