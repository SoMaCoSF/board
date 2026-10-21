---
'vboard': patch
---

A Slack reply in a thread the board hasn't seen lands under its root instead of as a new root. That covers a thread that started before its channel was mapped, and one whose root never synced. The board reads the root from Slack (`conversations.replies`) and brings it in as it would have arrived itself: its author, mentions, files, and links. Then the reply posts under it. The root keeps its Slack message, so its later edits, reactions, and deletes sync. A reply whose root was deleted lands as a root of its own, as before, and so does one whose root Slack won't hand over after five tries.

A GitHub comment whose PR or issue can't be fetched after five tries lands as a root of its own too, so it no longer dead-letters and holds up the PR's other events. `SyncProvider.fetchRoot` takes the sync key as a second argument. A root it returns can carry `message`, `files`, and `links`.
