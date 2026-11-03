import { board } from "@vercel/board";
import { http } from "@vercel/board/backend-http";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { liveDeps, setup } from "../../lib/setup";
import { BOARD } from "../lib/identity";

// What the factory's setup page shows, checked now: the same checks, so the agent never guesses at them.
export default defineTool({
  description:
    "The factory's setup, checked now: each step the setup page shows (Vercel, GitHub, Slack, Try it), whether it's done, what was found, and what to do, with the exact commands. Use it whenever someone asks about setting the factory up, and quote its commands as they are.",
  inputSchema: z.object({}),
  async execute() {
    const reader = board({ backend: http(BOARD) });
    const steps = await setup(await liveDeps(async (query) => (await reader.messages(query)).messages));
    return JSON.stringify(steps.map(({ title, status, optional, summary, rows, fix }) => ({ title, status, optional, summary, rows, fix })), null, 2);
  },
});
