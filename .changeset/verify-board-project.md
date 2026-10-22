---
'vboard': patch
---

`vb` and `http()` in Node mint a person's token only for the project the board's host is a deployment of. Before, they minted for whatever project a board's discovery named, so a board could name any project you can access and collect a development token for it, which Trusted Sources accept on that project's deployments whatever its audience. Now they ask Vercel, with your login, which project the host belongs to (its deployment URL, a branch alias, or a domain), and mint only when it's the one discovery names. A board whose host is another project's deployment fails with `wrong_project`, and a host Vercel finds nothing at for you fails with `no_access`. A board on localhost still mints for the project it names.
