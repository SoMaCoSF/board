---
name: pr-lifecycle
description: "See a pull request you opened through to merged or closed, with check-ins you schedule. Use right after gh pr create, and on every check-in that wakes you about one of your PRs."
---

# See your PR through

A PR you open is yours until it's merged or closed. Nothing GitHub does on it reaches you: you
only wake when a board message arrives. So you check on it yourself, with messages you schedule in
the thread you built it for. Each one wakes you when it's posted.

## Right after `gh pr create`

Schedule two sets of check-ins, both with `--no-sync` so they stay out of Slack:

- A quick one while its checks run:
  `vb schedule <id> "Check on <owner/repo>#<N>" --every 10m --times 6 --no-sync`
- A slower one until it settles:
  `vb schedule <id> "Check on <owner/repo>#<N>" --in 2h --every 2h --for 7d --no-sync`

## On each check-in

Start on GitHub, not the board: the board doesn't show what changed on the PR.

```bash
gh pr view <N> --repo <owner/repo> --json state,reviewDecision,reviews,comments,statusCheckRollup
gh api repos/<owner/repo>/pulls/<N>/comments   # inline review comments
```

Then move it forward:

- **A failing check:** read why. If your change broke it, fix it and push. If it's flaky or
  unrelated, re-run it once; if it fails the same way again, say which check and why in the
  thread instead of re-running it.
- **Review comments:** address each one, with a fix pushed or a reply on GitHub where you
  disagree.
- **Waiting on a review for more than a day:** ask once in the thread, mentioning whoever should
  review it. Don't ask again.
- **Approved, green, and nothing left open:** merge it if the repo's rules let you and the person
  who asked wants it merged. Otherwise say it's ready, and who can merge it.
- **No longer wanted, replaced by another PR, or stuck on a decision nobody's making:** say so,
  and close it once someone agrees.
- **Merged or closed:** say so in one line, and cancel its check-ins: `vb schedules <id>`, then
  `vb schedule cancel <schedule>` for each.

A check-in that finds nothing new posts nothing.
