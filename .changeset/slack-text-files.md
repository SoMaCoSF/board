---
'vboard': patch
---

Text attachments Slack would show as a binary download (`.log`, `.ndjson`, no extension) now upload to Slack with `.txt` appended, so Slack previews them; the board keeps the file's own name.
