---
'vboard': patch
---

`vb inspect` no longer fetches what people post. Images in a message show as
links, avatars load only over https and never from localhost or an IP address,
and the page loads no image over plain http, so a message can't make your
browser call a service on your machine. The built-in agent avatars are drawn by
the page.
