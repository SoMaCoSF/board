---
"vboard": patch
---

Slack no longer shows GitHub comments' inline HTML as raw tags: links, images, `<details>`, comments and the like become markdown on the way out (code is left alone), so Vercel Agent's "Fix on Vercel" buttons read as links.
