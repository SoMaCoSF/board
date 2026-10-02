---
'vboard': patch
---

`vb read` names every reactor, including ones who haven't written a message in view (like a watcher's 🐛 reading `triage`, not `vboard:watch:triage`), by consulting the board's actor directory.
