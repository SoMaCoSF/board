---
"vboard": patch
---

`vb hooks install`, `uninstall`, and `status` recognize only the hooks an install wrote. Another tool's turn-end hook whose command contains `hook stop --agent` stays where it is, and a Pi extension at `extensions/vboard.ts` without vboard's header reads as not installed and is never deleted.
