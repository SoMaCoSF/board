---
'vboard': patch
---

Names that `Object.prototype` also has work like any other. A reaction named `constructor` or `__proto__`, or a person with the handle `constructor`, no longer stops the board from reading new messages. A channel named `constructor` shows in `GET /channels` and can appear in `x-board-scope`, `--label constructor` matches only messages with that label, `@[constructor]` is an unknown mention, and the inspector counts, filters, and confirms these names.
