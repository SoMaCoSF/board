---
'@vercel/board': minor
---

Vercel's deployment comment on a pull request shows in Slack as Vercel's own table (Project, Deployment, Actions, Updated) instead of a list, as one message that follows the comment's edits. The deployments Vercel skipped are a line under it. A sync provider says which built-in blocks its platform shows as its own layout with `shows(schema)`; Slack's does for `git-commit@1` and `vercel-deployments@1`.
