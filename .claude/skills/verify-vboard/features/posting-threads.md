# Posting and threads

## Sub-features

- `vb post <channel> "<text>"` starts a thread and prints its id; `--label k=v` labels the root.
- `vb reply <id> "<text>"` adds to a thread; replying to a reply files it in the same thread.
- Text from stdin with `-`; text may be left out with `--attach`.
- `--attach <file>` (repeatable) uploads files; `vb download <attachment> [path|-]` gets one back.
- `--id <key>` makes a post or reply idempotent: the same key returns the same id.
- `vb edit <id> "<text>"` and `vb delete <id>` (a deleted message reads as `(message removed)`).

## How to get to it (user POV)

From a project linked to a board (`vb serve` links it), run `vb post dev "…"`, note the id, then
`vb reply <id> "…"` and `vb read <id>` to see the thread.

## Driving it with the sandbox

```bash
$V/drive-posting.sh "$S"                     # the whole feature, with checks
$V/vb.sh "$S" post dev "first" --label kind=task
$V/vb.sh "$S" reply 2 "second"
$V/sh.sh "$S" 'echo "from stdin" | vb reply 2 -'
$V/sh.sh "$S" 'printf "notes\n" > notes.txt && vb reply 2 "with a file" --attach notes.txt'
$V/vb.sh "$S" read 2
```

Proven output (`vb read 3`):

```
#3  ubuntu · 23s  [kind=task]
      first thread from a fresh sandbox
  ↳ #4  ubuntu · 19s (edited)
    a reply in the thread, edited
  ↳ #6  ubuntu · 13s
    with a file
    file notes.txt · text/plain · 6 B · ZNtC-mvCtG8GiP0yn-ssNw
```

The attachment lands at `.vboard/attachments/vboard/attachments/<id>` (plus `.type` and `.json`
sidecars); `collect.sh` copies it out.

## Gotchas

- Ids are log indexes, not message counts: labels, reactions, and edits take indexes too, so the
  next post's id skips ahead. Read the id from `post`'s output; don't predict it.
- `edit`, `delete`, `react`, and `label` print nothing on success: follow each with a read.
- A repeated `--id` key returns the first post's id and posts nothing new.
- Errors: `vb post` with no channel exits 2 (`error: usage: vboard post <channel> "<text>"`);
  `vb reply 999999 …` exits 1 (`error: message not found: #999999`).
- `--attach` paths resolve in `/vercel/proj` (the wrappers' working directory).
