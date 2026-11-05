---
'@vercel/board': minor
---

`vb grants create vercel --projects --environment production` lets in every project on the board's team, and `--project prj_123` one project, by its ID. Either keeps the grant to the board's own team, as the board's discovery names it, unless `--claim owner_id=<team>` names another. A board that names no team (`vb serve` outside a linked directory) says so and takes the team as that claim. `--environment` is required, and `--projects` with `--project` is misuse. `--claim` alone works as before. `vb grants` says who a Vercel grant lets in, in words: `every project, production`, `prj_front on team_partner, production`.
