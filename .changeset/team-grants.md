---
'@vercel/board': minor
---

A Vercel grant that names `owner_id` and `environment` and no `project_id` lets in every project on that team, in that environment, ones made later included: `team.createGrant({ issuer: 'vercel', claims: { owner_id: 'team_acme', environment: 'production' } })`. Before, every Vercel grant had to name one project. A grant for a whole team names `production`, `preview`, or `development`, since a custom environment's ID is one project's, and a Vercel grant that names neither a project nor a team is still 400 `invalid_grant`. The conformance kit's `grants` group checks all three.
