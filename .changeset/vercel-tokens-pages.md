---
'@vercel/board': patch
---

On Vercel's board, `vb tokens` and `tokens()` list every board token, following Vercel's API page by page once it pages `GET /tokens`, instead of only what its first answer holds. Against an API that doesn't page yet, its one answer is still the whole list.
