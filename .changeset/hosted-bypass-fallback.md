---
'vboard': patch
---

A client on Vercel whose `VERCEL_AUTOMATION_BYPASS_SECRET` is rejected falls back to Vercel OIDC trust instead of failing. Vercel sets that variable to the calling project's own bypass, which opens that project's boards and not another project's.
