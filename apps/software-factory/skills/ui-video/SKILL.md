---
name: ui-video
description: Record a captioned, narrated video of a UI change working, driven with the computer tool on a virtual desktop, and attach it to a board reply. Use whenever a change touches UI, to show people it works instead of telling them.
---

# Show a UI change on video

When a change touches UI, prefer showing people it works over telling them.
You decide how: a video for a flow people click through, a screenshot when
one still frame shows it, or nothing when there's nothing to see (say so in
the PR instead).

The video is a recording of your virtual desktop while you use it with the
`computer` tool: you see each screenshot it returns, and click and type like a
person would. Each `computer` call's `title` becomes the video's caption from
that moment on, and a narrator reads it aloud, so write titles for the people
watching. `scripts/ui-video` in this skill's directory records the desktop,
burns the captions in and adds the narration.

The narrator is a speech model on AI Gateway (`openai/tts-1`, voice `nova`;
set `UI_VIDEO_VOICE_MODEL` and `UI_VIDEO_VOICE` to change them). Each title
is said before its action happens, so the action follows the voice. If a line
can't be spoken, it's captioned only. Use `ui-video start --mute` when sound
adds nothing.

## 1. Pick where to test it

Use whichever shows the change best:

- **The PR's preview deployment**, when the change needs real data,
  sign-in or the deployed setup. A factory PR's branch `pi/<thread>` deploys to
  `https://vboard-factory-git-pi-<thread>.playground-vercel.tools`
  (for example `pi-3100`). The sandbox's network policy adds the Vercel
  Authentication bypass to that host, so it opens without signing in to Vercel.
  Other preview hosts still ask for Vercel login, so use a local server for
  them. Wait for the deployment first: `gh pr checks <N> --watch`.
- **A local dev server**, when the change is self-contained, the preview isn't
  ready, or you're working on something with no deployment (`vb inspect`, a
  docs page). Start it in the background
  (`pnpm --filter software-factory dev > /tmp/dev.log 2>&1 &`) and poll it with
  curl until it answers.

## 2. Rehearse, then record

Do the flow once without recording, so the take has no dead ends: `computer`
with `action: "open"` and the `url` opens Chrome on the desktop. Close the tabs
the rehearsal left (`ctrl+w`), so the take starts clean. Then:

1. `scripts/ui-video start`
2. Do the flow with `computer`, one action per call. Titles are short
   first-person sentences people can read (and hear) in about 2 seconds,
   written to be said (words, not symbols or paths): "Opening the
   board", "Typing the reply", "The reply shows up with its file: it works".
3. `scripts/ui-video stop /tmp/<thread>-<flow>.mp4`

- Only title a result ("it worked", "the message is posted") once the
  screenshot shows it. If the flow fails, record the failure and say so in the
  title. Don't attach a video that claims something the screen doesn't show.
  To caption without acting, use `action: "screenshot"`.
- The take keeps each spoken line and a few seconds after its action, and cuts
  the time you spend thinking, so it stays short however long you take.
- `stop` shrinks the mp4 to fit the board's 4 MB limit. If it says the video
  is still too big, record a shorter take.

## 3. Check it, then attach it

Grab a frame and look at it before posting:
`ffmpeg -nostdin -loglevel error -ss 3 -i <video>.mp4 -frames:v 1 -update 1 /tmp/frame.png`.
Then attach the video to the reply that links the PR:
`vb reply <id> "<text>" --attach /tmp/<thread>-<flow>.mp4`.
In the PR body, give the flow you recorded and where (the preview or a local
server) in one line.
