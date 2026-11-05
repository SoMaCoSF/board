---
'@vercel/board': minor
---

`vb grants create oidc --issuer <url|github> --claim k=v` grants any issuer's tokens other than Vercel's: `--issuer github` is GitHub Actions, and any other is its https URL. Help shows `vercel` and `oidc` as the two forms. `vb grants create github …` and `vb grants create https://… …` still work, as the same grants. A first argument that's none of these, `vb grants create gitlab`, says to use `oidc --issuer`, where it was the board's `invalid_grant`.
