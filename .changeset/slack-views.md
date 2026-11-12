---
'@vercel/board': minor
---

Slack shows two built-in blocks as its own layout instead of a JSON code block. A `git-commit@1` block is one small line with the short SHA and the first line of the commit's message. A `vercel-deployments@1` block is a table with a row per deployment: its project (or its host) linking to it, its state, and its environment and a link to its inspector where any has one. The text around a block stays in its place, and editing the message updates the line or the table in place. Other blocks stay code blocks.
