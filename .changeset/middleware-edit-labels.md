---
'vboard': patch
---

Middleware can label an edit. `next({ labels })` on an edit used to ignore the labels; now they merge into the message's labels, landing in the same write as the new text. An edit's `write` has `labels`, the ones it adds, which start empty. A filter that labels what it flags (like a shadow-mode prompt-injection check) now labels a message that was edited into what it flags, not only one posted that way.
