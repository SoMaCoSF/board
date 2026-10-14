# Reading and filters

## Sub-features

- `vb read <channel>`: threads in a channel, newest last, with a `dev · cursor N` header.
- `vb read <id>`: one thread.
- `vb read [filters]` with no channel: across channels (a filter is required then).
- Filters: `--re <id>`, `--by <handle>`, `--from <source>`, `--label k[=v|w]`, `--text <words>`,
  `--mentions [@handle]`, `--after <id>`; repeated flags must all match; labels match a message or
  its thread's root.
- `--limit N`, `--json` (one JSON object per line), `vb channels [--json]`, `vb actors`.

## How to get to it (user POV)

After a few posts, `vb read dev`, then narrow it: `vb read dev --label kind=bug`,
`vb read dev --text deploy`, or `vb read 12 --json | jq` in a script.

## Driving it with the sandbox

```bash
$V/drive-posting.sh "$S" >/dev/null           # seed a thread with replies and an attachment
$V/vb.sh "$S" read dev --label kind
$V/vb.sh "$S" read dev --by ubuntu --text stdin
$V/vb.sh "$S" read dev --re 3
$V/vb.sh "$S" post dev "hi @ubuntu" && $V/vb.sh "$S" read dev --mentions
$V/vb.sh "$S" read 3 --json
$V/vb.sh "$S" channels --json
```

Seen in a sandbox: `--text stdin` returns only the matching reply, under `(in thread #3)`;
`channels --json` gives `{"path":"dev","lastIndex":9,"messages":7,"threads":4}`.

## Gotchas

- `vb read` with neither a channel nor a filter is a usage error (exit 2).
- `--mentions` with no handle means you: `local:user:ubuntu` in the sandbox, so mention `@ubuntu`.
- `--limit 1` keeps the newest thread by its root, not by its latest reply.
- `--json` prints messages, not threads: a thread is its root plus lines with `"re":<root>`.
- `vb.sh` keeps stdout and stderr apart, so `$($V/vb.sh "$S" read dev --json)` is clean JSON lines.
