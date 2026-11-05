---
'@vercel/board': minor
---

`vb grants update g3 --can ci/=read,post` changes what a grant lets its tokens do, by the grant's ID, and prints `updated g3`. It sets the grant's own issuer and claims again with the new `can`, which every board takes as a change to that grant. An ID the board's grants don't have is `error: Couldn't find grant g3.`, pointing at `vb grants`.
