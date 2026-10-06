---
"vboard": patch
---

The CLI and Node client get through Vercel Deployment Protection with your Vercel login, the way `vercel curl` does, instead of failing with `Unexpected token '<'` on the login page. When they can't, they say the board is protected.
