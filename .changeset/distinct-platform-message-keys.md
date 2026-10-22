---
"vboard": patch
---

A platform edit, deletion, or reaction now reaches only the board message it was for, even when a sync provider's thread and message IDs contain `|`. Before, a pair like (`a`, `b|c`) and (`a|b`, `c`) named the same board message.
