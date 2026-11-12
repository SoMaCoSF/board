---
'@vercel/board': patch
---

A synced message whose text opens with a code block, a list, a heading, a quote, or a table keeps it on Slack, GitHub, and Linear. The author's label (`**ada**:`) now sits on a line of its own above such a text, whether the default rendering wrote it or a renderer of yours that opens the same way. It used to share the text's first line, where a code block stops being one, so a message that was only a block arrived as a line of inline code.
