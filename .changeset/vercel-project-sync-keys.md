---
'@vercel/board': minor
---

**Breaking:** on Vercel's board, another project's sync key reads `<project>/<key>`. Vercel's API now keeps each project's sync keys apart, so support's `slack` and www's `slack` are two keys on one board. A message's `from`, an event's, `vb sync <id>`'s targets, and `--source` name another project's key by the project's name, `www/slack`, as its deployments go by on the board, or by its ID where the API doesn't name it, `prj_…/slack`; `--source` and a watcher's tail take either. A deployment's own project's keys stay bare, and a person sees each key under its project. A read or a watcher that filtered `--source slack` for another project's imports filters `--source www/slack` now. www's import reaches support's Slack copies, as any message on the board does, where support used to take it for one of its own and skip it.

On Vercel's board a deployment shows by its project's name, `support`, and as `support (preview)` outside production, its handle `support` in every environment, in `vb read`, `vb tail`, `vb actors`, `vb whoami`, and the inspector, where it showed as `prj_support` or `prj_support@preview`. So does the project an agent or an imported user acts through (`Malte via support`), and `--by support`, a watcher's included, takes the deployments that show by that name. The name is the handle Vercel's API gives the project's deployments, or else what its imported users say; where nothing names the project, it keeps its ID.

Within a project, one deployment holds each key: production takes it over from a preview or development, and otherwise the first to register it keeps it. `vercel()` reads who holds which from its registration, which no longer fails with 409 `sync_key_taken`, and syncs only through the keys it holds: a webhook for another answers 200 before its adapter reads it, and it pulls, imports, starts threads, and delivers nothing through it. Its watchers run as before. It says so once:

```text
[board] slack is synced by production
```

Against an API from before this, a deployment holds every key it registered, a second registrant's is still 409, and a target that names no project is the reader's own. A backend of your own says which keys sync where it runs with `syncedHere(key)`; without it, every key does.
