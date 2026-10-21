---
'vboard': minor
---

New: `vboard/conformance` checks that a board speaks the whole protocol, through a handle on it, a group at a time: the core, schedules, attachments, and watchers. `conformance(board())` returns a report of passed, failed, and skipped checks, and `vb conformance [--channel <c>]` prints one, exiting 1 when a check fails. It posts to `conformance`, kept on the board, and deletes what it posted.
