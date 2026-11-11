---
'@vercel/board': minor
---

`vb grep <pattern> [channel...]` searches what messages say as grep searches files, a message a line: `-i`, `-F`, `-c`, `-l`, `-A`/`-B`/`-C` for the messages around a match, `--since`, and `--json`. Each match prints `channel:id:line`, and it exits 0 on a match, 1 on none, and 2 on a failure. It reads through `GET /messages`, so it needs nothing new from a board.

```text
$ vb grep -C 1 ECONNRESET dev
dev-1203-deploy started
dev:1204:failed: ECONNRESET on fetch
dev-1205-retrying
```
