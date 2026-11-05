---
'@vercel/board': minor
---

`--can` on `vb grants create`, `grants update`, and `tokens create` takes `none` for no permissions in a pattern, as `all` is every one: `--can '*=read,post;security/=none'` reads and posts everywhere but `security/`. `vb grants` and `vb tokens` list an empty pattern as `security/=none`, where they showed `security/=`, which `--can` still takes. The board still gets an empty list, so nothing changes in what a board accepts.
