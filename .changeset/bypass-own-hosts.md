---
'vboard': patch
---

On Vercel, the Node SDK sends `VERCEL_AUTOMATION_BYPASS_SECRET` only to the deployment's own hosts (`VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`). Vercel sets it to the calling project's own bypass, so a client for another project's board no longer leaks it there and uses Vercel OIDC trust instead.
