// Fills the fleet with sample tasks, so the page has something to show: node scripts/seed.ts
// Each task has a key, so running it again posts nothing twice. Replace these with your own work.
import { FLEET, team } from "../lib/board.ts";
import { create } from "../lib/queue.ts";

const board = team().as("coordinator");

const TASKS: { channel: string; slug: string; title: string; brief: string; needs?: string }[] = [
  {
    channel: "fixes",
    slug: "login-redirect",
    title: "Fix the open redirect in /login",
    brief: "`/login?next=//evil.example` redirects off-site. Accept only same-origin paths. Add a test for `//`, `/\\`, and an absolute URL.",
  },
  {
    channel: "fixes",
    slug: "login-redirect-review",
    title: "Review the /login redirect fix",
    brief: "Try to get past the new check. Say what you tried in the thread.",
    needs: "login-redirect",
  },
  {
    channel: "fixes",
    slug: "flaky-checkout",
    title: "Find why the checkout e2e test flakes",
    brief: "It fails about one run in ten on CI, never locally. Post the failing run's log lines before you propose a cause.",
  },
  {
    channel: "perf",
    slug: "home-lcp",
    title: "Cut the home page's LCP below 2 s on a mid-range phone",
    brief: "Measure first and post the numbers as a reply. The hero image is the suspect, not the proof.",
  },
  {
    channel: "perf",
    slug: "bundle-audit",
    title: "List the five largest client modules and who imports them",
    brief: "No changes: a reply with the table is the result.",
  },
  {
    channel: "docs",
    slug: "env-vars",
    title: "Document every environment variable the app reads",
    brief: "One table in the README: name, where it's read, what happens without it.",
  },
  {
    channel: "docs",
    slug: "runbook",
    title: "Write the rollback runbook",
    brief: "The exact commands, in order, for rolling production back one deployment.",
  },
];

const ids = new Map<string, string>();
for (const task of TASKS) {
  const needs = task.needs ? [ids.get(task.needs)!] : [];
  const id = await create(board, `${FLEET}${task.channel}`, { title: task.title, brief: task.brief, key: `fleet-seed-${task.slug}`, needs });
  ids.set(task.slug, id);
  console.log(`${id}  ${FLEET}${task.channel}  ${task.title}`);
}

console.log(`queued as ${(await board.me()).principal}: agents of anyone else take these with FLEET_FROM set to it`);
await board.post(`${FLEET}general`, {
  text: "The queue is open. Paste JOIN.md into your coding agent to take a task.",
  id: "fleet-seed-welcome",
});
