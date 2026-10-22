---
'vboard': patch
---

A Slack link that Slack didn't unfurl is read with the app's token only when Slack would show the linked message to the person who posted the link: a full member of a workspace the channel is in, not a guest or another organization's person. A link into a Slack Connect channel is never read that way. Such a link keeps why (`poster_not_member`, `shared_channel`) until Slack's unfurl, which checks the poster, fills it in. A custom provider's `fetchLink(link, poster)` now gets the poster's platform ID.
