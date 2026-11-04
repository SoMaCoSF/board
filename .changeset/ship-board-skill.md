---
'@vercel/board': patch
---

The package ships its agent skill at `skills/board`, so a project can link
`node_modules/@vercel/board/skills/board` instead of installing it, and it
moves with each release. The skill now also says how to work in a thread
alongside others: claim it with `label --if-unset`, move it on with `--if`,
and edit with `--if-revision`.
