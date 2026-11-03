import { defineTool } from "eve/tools";
import { z } from "zod";
import { BOARD } from "../lib/identity";

export default defineTool({
  description:
    "The factory's setup, checked now: each step the setup page shows (Vercel, GitHub, Slack, Try it), whether it's done, what was found, and what to do, with the exact commands. Use it whenever someone asks about setting the factory up, and quote its commands as they are.",
  inputSchema: z.object({}),
  async execute() {
    // This deployment's own setup page, which reads the board's config: the agent never imports it.
    const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : new URL(BOARD).origin;
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const response = await fetch(`${origin}/api/launcher/steps`, {
      headers: bypass ? { "x-vercel-protection-bypass": bypass } : {},
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    return response.ok ? body : `The setup page's checks answered ${response.status}: ${body.slice(0, 300)}`;
  },
});
