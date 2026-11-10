---
'@vercel/board': minor
---

A new board lets every project on its team `sync`, as Vercel's API now starts a team's board: g2 gives every project's deployments, previews included, read, post, react, label, and `sync` everywhere. So any of them may speak for platform users through sync's routes: register a platform, import as its users, and attach a thread to a Slack channel or a GitHub issue the board's own sync reaches. `vercel()`'s `me()`, and so `vb whoami`, show `sync` for a deployment's own credential. Apps (g3) and board tokens minted without a `can` that says `sync` still don't sync.

Boards on Vercel's API that already exist keep their grants. A local board doesn't store a starting grant until you change it, so on one where g2 is as it started, g2 syncs too once you upgrade; one that changed or revoked g2 keeps what it set. To keep `sync` to the deployments that run a sync, take it from g2 and grant it back to them where they sync:

```text
$ vb grants update g2 --can '*=read,post,react,label'
updated g2  --all-projects --environment production,preview,development  read post react label
$ vb grants create --project prj_support --environment production --can support=all
created g4  --project prj_support --environment production  support=all
```
