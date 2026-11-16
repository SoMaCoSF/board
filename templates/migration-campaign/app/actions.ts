"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { team } from "@/lib/board";
import { campaign as readCampaign, history } from "@/lib/campaign";
import { MAX_AGENTS, parseConfig } from "@/lib/config";
import { OPEN, open } from "@/lib/gate";
import { cancel as cancelTask, unblock } from "@/lib/queue";
import { begin, change, launch, reconcile, scale } from "@/lib/run";

// What the page does, as this deployment. Every action that starts, stops, or spends something
// checks first that strangers can't reach the deployment.

type Result<T = object> = ({ ok: true } & T) | { ok: false; problem: string };

const ID = /^[\w.:#-]{1,128}$/;
const SLUG = /^c[a-z0-9]{4,16}$/;

async function guarded<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  if (await open((await headers()).get("host"))) return { ok: false, problem: OPEN };
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Starts a campaign from the form. It answers with the campaign's slug at once, and the checkout, the tasks, and the agents follow. */
export async function start(input: unknown): Promise<Result<{ slug: string }>> {
  const parsed = parseConfig(input);
  if ("problem" in parsed) return { ok: false, problem: parsed.problem };
  return guarded(async () => {
    const campaign = await begin(parsed.config);
    // The slow part runs after the response: the page is already showing the campaign's thread.
    after(() => launch(campaign));
    return { slug: campaign.slug };
  });
}

export async function setState(slug: string, to: "stopped" | "paused" | "running"): Promise<Result> {
  if (!SLUG.test(slug)) return { ok: false, problem: "not a campaign" };
  return guarded(async () => {
    await change(slug, to);
    return {};
  });
}

export async function setAgents(slug: string, agents: number): Promise<Result> {
  if (!SLUG.test(slug) || !Number.isInteger(agents) || agents < 1 || agents > MAX_AGENTS) return { ok: false, problem: `1 to ${MAX_AGENTS} agents` };
  return guarded(async () => {
    await scale(slug, agents);
    return {};
  });
}

/** Answers a held task: the note goes in its thread, where the next agent reads it, and the task is ready again. */
export async function answer(slug: string, id: string, note: string): Promise<Result> {
  if (!SLUG.test(slug) || !ID.test(id)) return { ok: false, problem: "not a task" };
  return guarded(async () => {
    await history(slug, id); // only a task of this campaign
    if (note.trim()) await team().reply(id, note.trim().slice(0, 4_000));
    await unblock(team(), id);
    await reconcile(slug, team(), undefined, { force: true });
    return {};
  });
}

/** Calls a task off: no agent takes it again. */
export async function cancel(slug: string, id: string): Promise<Result> {
  if (!SLUG.test(slug) || !ID.test(id)) return { ok: false, problem: "not a task" };
  return guarded(async () => {
    await history(slug, id);
    await cancelTask(team(), id, "Canceled from the campaign's page.");
    return {};
  });
}

/** A task's thread, for the panel a click opens. */
export async function thread(slug: string, id: string) {
  if (!SLUG.test(slug) || !ID.test(id)) throw new Error("not a task");
  return history(slug, id);
}

/** Whether a campaign exists yet: the form waits for its thread before sending the browser to it. */
export async function exists(slug: string): Promise<boolean> {
  return SLUG.test(slug) && (await readCampaign(slug)) !== null;
}
