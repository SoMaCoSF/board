import { team } from "@/lib/board";

// Answers only the factory's wake-ups: everything else on the board is the factory's.
export const GET = team.fetch, POST = team.fetch;
