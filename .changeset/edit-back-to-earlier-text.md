---
"vboard": patch
---

An edit on Slack or GitHub back to text the message had before reaches the board. Before, its delivery key matched the earlier edit's, so the board took it as a retry and kept the newer text. Chat SDK providers now tell edits apart by the message's `metadata.editedAt`.
