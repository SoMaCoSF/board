---
"vboard": patch
---

Claude Code shows the turn-end reminder once, as hook feedback, instead of twice with a hook error: the hook answers with `additionalContext` rather than a blocked stop. Without a board, the CLI also points to `vb serve` for a local one.
