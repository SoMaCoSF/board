import type { NextConfig } from "next";
import { withEve } from "eve/next";

// The agent in agent/ is mounted at /eve/v1, beside the board at /api/board.
const config: NextConfig = {};

export default withEve(config);
