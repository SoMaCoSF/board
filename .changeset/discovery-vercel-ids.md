---
'vboard': patch
---

The Node client and the CLI won't mint a token with your `vercel login` for a board whose discovery names a Vercel project or team that isn't a Vercel ID (`prj_…`, and `team_…` or an account ID). They fail with `invalid_discovery`. Before, a board you pointed `vb` at could set its project ID to a path, and your login signed a request to that path on the Vercel API.
