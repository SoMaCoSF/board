---
'vboard': minor
---

A message synced from a platform links to where it came from, and a delivery receipt links to where it went. `origin.url` on a message (in `vb read --json`, the SDK, and every view) is its link on the platform, and `message.synced`'s `external.url` is the copy's. Slack builds both on the workspace's host, from the one `auth.test` the app already makes, so a message costs no `chat.getPermalink`; GitHub takes the PR's, issue's, or comment's `html_url`. Each is null where the platform has no links, and on messages and receipts from before this release.

A sync callback's `message` event has the same link as `event.url`. A custom provider sets `url` on the `message` events it emits and on what `post` returns; one built on `ChatSyncProvider` gives a `url(thread, message, raw)` hook, which `post` calls with what the adapter answered. Leave them out where the platform has no links.
