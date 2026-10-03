---
'vboard': patch
---

Mentions reach Slack and GitHub as real mentions. A board message that mentions a Slack user posts `<@U0456>` to Slack, so they're notified, and a GitHub user gets `@login` on GitHub. Anyone else shows up by name. Before, the text went out as written: `@[slack:user:U0456]` showed literally, and a bare `@handle` became a Slack mention of a user ID that doesn't exist.
