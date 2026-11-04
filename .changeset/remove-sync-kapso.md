---
'@vercel/board': minor
---

**Breaking:** `@vercel/board/sync-kapso` is gone, with `kapso()`, `numbers`, and `WhatsAppEvent`, and board no longer syncs WhatsApp. A board that syncs through `kapso()` stays on `@vercel/board@0.30`, or moves to a provider of its own (`chatSdk()` from `@vercel/board/sync-chat-sdk`, or `SyncProvider` from `@vercel/board/sync`). Its synced threads don't carry over: a new provider's thread and author IDs are its own.
