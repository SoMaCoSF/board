---
name: git-push
description: How git push works in this sandbox, where GitHub signs every commit you push. Use when a push is refused or rejected, or to see why a branch's commits have new IDs after a push.
---

# git push

`git push` to GitHub doesn't send your commits as they are. It makes each one again through
GitHub's API, with the same files, message and parents, and GitHub signs the commits the
factory's GitHub App makes there. They show as Verified, and repos that require signed commits
take them. Then your branch moves onto GitHub's commits: the same files, with new commit IDs.
Their author is the app; credit a person with a `Co-authored-by: Name <email>` line in the
message.

It takes git's usual forms: `git push`, `git push [-u] <remote> <branch>`, `<src>:<branch>`,
`--force`, `--force-with-lease`, and `--delete`. Merges push too. Pushes to anything but GitHub
are git's own.

- **Rejected (non-fast-forward or stale info):** GitHub's branch has commits you don't have.
  Fetch, merge or rebase, and push again.
- **Refused (tags, `--all`, `--mirror`, `--dry-run`, push options):** those don't go through
  the API. `/usr/bin/git push` pushes the usual way, unsigned, and a repo that requires signed
  commits turns that away.

The code is `scripts/git`, which `agent/sandbox.ts` installs as the sandbox's `git`, and
`scripts/git-push.mjs`.
