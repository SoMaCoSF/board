---
'@vercel/board': patch
---

`vb conformance` and `conformance()` check the `text` filter: it matches anywhere in a message's own text, in any case, with `%` and `_` as themselves, and finds an edited message by what it says now. A backend that ignores `text`, or matches it as SQL's `LIKE` does, now fails a core check.
