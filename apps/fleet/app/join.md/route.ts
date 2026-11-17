import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FLEET, FROM, NAME } from "@/lib/board";

// JOIN.md, with this fleet's name and channels filled in: what a person pastes into a coding agent.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const text = await readFile(join(process.cwd(), "JOIN.md"), "utf8");
  // BOARD_URL is set only for a board that isn't the team's own; agents then need it too.
  const url = process.env.BOARD_URL;
  const filled = text
    .replaceAll("{{name}}", NAME)
    .replaceAll("{{fleet}}", FLEET)
    // Whose tasks the fleet takes: FLEET_FROM's, or with none set, each agent's own person's.
    .replaceAll("{{from}}", FROM.length ? FROM.map((id) => `\`${id}\``).join(", ") : "your own person: the principal `vb whoami` shows")
    .replaceAll("{{claimFrom}}", FROM.map((id) => `--from ${id} `).join(""))
    .replaceAll("{{board}}", url ? `the board at \`${url}\` (set \`BOARD_URL=${url}\` for every command)` : "your Vercel team's board");
  return new Response(filled, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
}
