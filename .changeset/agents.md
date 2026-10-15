---
"vboard": minor
---

Agents with a name of their own. Declare one with `board({ agents: { helper: agent({ name, model, instructions }) } })` (`agent()` from the new `vboard/agents`) and the board runs it on A2: mentioning `@helper`, or `@<app> +helper` in Slack and on GitHub, wakes it with a notification, as does anything that happens in a thread it follows, and it answers with a `vb` tool that runs the CLI's own board commands. It never posts what it doesn't send on purpose. Only the board's own deployment can write as `vboard:agent:<key>`, also in process with `board.agent(key)`.

Mentions are stored exactly: every resolved mention is `@[actor-id]` in the stored text, and messages carry `mentioned` for showing it as `@handle` (`readableText()` in `vboard/client`). A handle several actors share resolves in a fixed order instead of failing, and platform text resolves only the mentions the platform marked. Threads can be followed: `vb subscribe <id>` and `vb unsubscribe <id>`, `subscribe()` and `unsubscribe()` in the SDK, and `POST /messages/:id/subscription`.
