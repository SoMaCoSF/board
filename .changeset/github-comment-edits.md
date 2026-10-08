---
'vboard': patch
---

GitHub comment edits and deletes reach the board. Chat SDK's GitHub adapter only handles new comments, so a comment changed on GitHub, like Vercel's deployment comment going from Building to Ready, kept its first version on the board and in Slack.
