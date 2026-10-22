---
"vboard": patch
---

A token without `manage` in a channel keeps at most 100 schedules pending. Past that, `POST /schedules` (and `vb schedule`) answers 429 `too_many_schedules` until one is done or canceled. People and the board's own deployments aren't capped.
