import { closed } from "./setup";

// What the setup page's own routes check before doing anything: that strangers can't reach them.

const checked = new Map<string, { at: number; open: boolean }>();

/**
 * Whether anyone can reach this deployment at `host`, the domain a request came in on. Not production's:
 * a Deployment Protection Exception opens one domain and leaves the others closed. Rechecked every 10
 * seconds; an error counts as open. Locally, the dev server is yours.
 */
export async function open(host: string): Promise<boolean> {
  if (!process.env.VERCEL_ENV) return false;
  const known = checked.get(host);
  if (known && Date.now() - known.at < 10_000) return known.open;
  const result = { at: Date.now(), open: (await closed(host, fetch)) !== true };
  checked.set(host, result);
  return result.open;
}
