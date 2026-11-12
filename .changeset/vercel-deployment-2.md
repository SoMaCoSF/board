---
'@vercel/board': minor
---

Every board has a third built-in schema, `vercel-deployment@2`: a Vercel deployment and where it stands. It holds `url` and `state` (`queued`, `building`, `ready`, `error`, or `canceled`), and optionally `project`, `environment`, `gitSha`, and `inspectorUrl`, so a message can say a deployment is building and be edited when it's ready. `vercel-deployment@1` stays as it is.
