import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  limits: {
    // Nobody could answer its "continue?" prompt: its sessions start from the board, not a chat.
    sessionUsage: () => false,
  },
});
