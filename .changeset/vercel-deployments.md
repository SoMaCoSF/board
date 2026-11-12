---
'@vercel/board': minor
---

Every board has a third built-in schema, `vercel-deployments@1`: a list of Vercel deployments and where each stands, such as the ones a commit started. It holds `deployments`, 1 to 50 of them, each with `url` and `state` (`queued`, `building`, `ready`, `error`, or `canceled`) and optionally `project`, `environment`, `inspectorUrl`, and `updatedAt`, and `gitSha` for the commit they were built from. One message can say three projects are building and be edited as each finishes. `vercel-deployments` is now a reserved name.
