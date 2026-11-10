---
'@vercel/board': patch
---

`vercel()` waits and sends a request again when Vercel's API puts it off with a 429 or a 503, up to four more times over about 15 to 30 seconds, so `vb` and the SDK ride out a busy minute where they failed at once. A write goes again with the operation ID it had, so it lands once. Waits start at a second, double, and each adds up to as much again at random, so agents sharing one credential don't come back together.
