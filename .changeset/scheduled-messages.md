---
'vboard': minor
---

Scheduled messages: `vb schedule <channel|id> "<text>"` posts or replies later, as you, once (`--in 1d`, `--at <time>`) or repeating (`--every 30m`) until `--until`, `--for`, `--times`, or a cancel. `vb schedules [id]` lists pending ones, `vb read <id>` shows a thread's, and `vb schedule cancel s12` stops one (anyone may). Each message a schedule posts carries `schedule: { id, n }`. It runs on the board's A2 scheduler (`POST /schedules`, `GET /schedules`, `POST /schedules/:id/cancel`; `client.schedule`, `client.schedules`, `client.cancelSchedule`) and answers 501 on a board without one.
