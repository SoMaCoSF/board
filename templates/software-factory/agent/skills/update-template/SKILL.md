---
name: update-template
description: "Bring a new release of the software factory template into this factory, keeping its own changes. Use for a board task labeled template=<version>."
---

# Update the template

This factory started as a copy of `templates/software-factory` in `vercel-labs/board`, at the
release in its `package.json` `version`. Since then it has changed on its own. An update is a
three-way merge: the template at that version (the base), the template at the new version, and
this repo as it is now.

1. Say in the thread what you're about to do, in one line.
2. Clone this factory's own repo (your instructions name it) and branch `factory/<thread id>`.
3. Fetch both template versions into it, so the merge has the base's files:

   ```bash
   base=$(node -p "require('./package.json').version")
   next=<the thread's template label>
   git fetch --depth=1 https://github.com/vercel-labs/board \
     "refs/tags/@vercel/board@$base:refs/template/base" \
     "refs/tags/@vercel/board@$next:refs/template/next"
   ```

4. Apply the template's changes between them with a three-way merge, stripping the template's path:

   ```bash
   git diff refs/template/base refs/template/next -- templates/software-factory \
     | git apply -3 -p3
   ```

   Where it conflicts, resolve it by hand: keep what this factory changed on purpose, and take what
   the template fixed or added. A file the template deleted that this factory changed stays, with a
   note in the PR.

5. Set `package.json`'s `version` to the new one, install, and run `pnpm typecheck` and `pnpm test`.
6. Open the PR with `gh pr create`, titled `Update the template to <version>`. Its body lists what
   the release changed in a few lines (the upstream diff and its changelog say), and each conflict
   you resolved and how.
7. Reply in the thread with the PR link.

Nothing merges without a person. If the release needs something only a person can do (a new
environment variable, a connector), say so in the reply and the PR.
