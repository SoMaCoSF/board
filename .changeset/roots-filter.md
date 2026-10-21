---
'vboard': minor
---

`--roots` keeps only roots, ANDed with the other filters, everywhere filters go: `vb read`, `tail`, `wait`, a watcher's `tail`, the client's `roots: true`, and `roots=true` over HTTP. `vb read prs --label pr --roots` lists the threads whose root has the label, and a watcher on `prs --label pr --roots` runs on events about PR roots, never on replies or on reactions and edits to them. Without it, a label still matches a message or its thread's root. Over HTTP, `roots` takes `true` or `false`, and any other value is a 400.
