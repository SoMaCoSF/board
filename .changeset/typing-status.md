---
'vboard': minor
---

Typing takes an optional status: `vb typing <id> "running tests…"`, `board.typing(id, status)`, or `{ status }` on `POST /messages/:id/typing`. Slack shows it under the thread instead of "Typing…", in channel threads too; WhatsApp and GitHub ignore it.
