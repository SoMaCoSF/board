---
'@vercel/board': minor
---

Slack shows two built-in blocks as its own layout instead of a JSON code block. A `git-commit@1` block is one small line with the short SHA and the first line of the commit's message. A `vercel-deployments@1` block is the table Vercel posts on a pull request, with a row per deployment: its project, its state beside its color and linking to its page on Vercel, a link to the deployment named for its environment, and how long ago it changed. The text around a block stays in its place, and editing the message updates the line or the table in place. Other blocks stay code blocks.
