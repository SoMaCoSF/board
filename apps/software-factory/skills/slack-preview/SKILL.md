---
name: slack-preview
description: Try a change to the software factory (apps/software-factory, or vboard's Slack sync) in real Slack before it lands, on your PR's preview, with its own Slack bot in #project-vboard-previews. Use when the change affects what the factory does in Slack (watchers, rendering, sync, Pi itself) and tests alone can't show it.
---

# Try a factory change in Slack

Your PR's preview (`pi/<thread>` → `$VBOARD_PREVIEW_URL`) is a whole factory of
its own: its own board, its own Slack bot, and its own Pis. Its bot lives in
#project-vboard-previews (`C0C7P6NN8FM`), never the real channel, and takes only
the threads it started or that mention it. You act there as **vboard tester**, a
bot your Slack calls are signed as (`$SLACK_TOKEN` is a placeholder the network
policy fills in, like your other tokens).

## 1. Give the preview its bot

Only once per PR. Label it, and CI makes the bot (`.github/workflows/preview-bot.yml`):

```bash
gh pr edit <pr> --add-label preview-bot
gh pr checks <pr> --watch        # "preview bot" and "Vercel – vboard-factory" both pass
```

The bot is named `vboard pi-<thread>`. Every push redeploys the preview; the bot
stays. Closing the PR turns it off.

## 2. Post as the board, see it in Slack

The preview adds its bot (and the tester) to the channel on its first Slack call:

```bash
vb --url "$VBOARD_PREVIEW_URL" post dev "trying #<pr>: <what you're checking>"
curl -s https://slack.com/api/conversations.history -H "Authorization: Bearer $SLACK_TOKEN" \
  -d channel=C0C7P6NN8FM -d limit=5
```

The board's post shows in Slack under your name, sent by the preview's bot.

## 3. Act as a person in Slack, see it on the board

Reply in that thread (no mention needed), react, or start a thread by mentioning
the preview's bot. Its user ID is in the `<@U…> has joined the channel` message
from step 2.

```bash
curl -s https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_TOKEN" \
  -d channel=C0C7P6NN8FM -d thread_ts=<ts> -d text="<what a person would say>"
curl -s https://slack.com/api/reactions.add -H "Authorization: Bearer $SLACK_TOKEN" \
  -d channel=C0C7P6NN8FM -d timestamp=<ts> -d name=shipit
vb --url "$VBOARD_PREVIEW_URL" read dev
```

The preview runs every watcher, its Pis included (in sandboxes of its own, on
the preview's board), so a change to triage, Pi, or a watcher shows up there as
it would in production. Give it a minute; then read the thread on the preview's
board and in Slack.

## 4. Say what you saw

In your board thread, say what you tried and what happened, with links to the
Slack messages (`https://vercel.slack.com/archives/C0C7P6NN8FM/p<ts without the dot>`).
Use `vb` without `--url` for that: your own thread is on production's board.
