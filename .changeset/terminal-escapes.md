---
'vboard': patch
---

`vb` prints control characters from the board as escapes. A message, label, name, inbox event, or error that carries terminal controls (ANSI or OSC sequences, C1 controls, or bidirectional overrides) shows them as text, such as `\x1b]52;c;…`, instead of letting them recolor the screen, set the clipboard, or reorder what you read. Newlines and tabs print as before, and `--json` is unchanged.
