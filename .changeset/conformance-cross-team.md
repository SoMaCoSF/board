---
'@vercel/board': minor
---

The conformance kit checks a grant for another team's project on its own, `grants another team's project`, apart from a GitHub repository's grant. A board that can't let another team in answers that grant with 501 `no_cross_team`, and the kit skips the check as `needs cross-team access: …`, neither passed nor failed. A team's board in Vercel's API answers so until Vercel's API has access across teams, and sends no such grant to it.
