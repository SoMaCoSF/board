# vboard

## 0.7.0

### Minor Changes

- c9b672f: `vb stuck` lists the events that failed 10 times and stopped their thread, across the board, every inbox, every watcher, and schedules, with the thread each holds up and its last error. `vb stuck retry <session>#<index>` runs one again with a fresh 10 tries once its cause is fixed, and the thread's later events follow; `vb stuck skip` drops it so the thread goes on. Before, the only way out was editing A2's store by hand. It's `GET /stuck` and `POST /stuck/redrive` (`client.stuck()`, `client.redrive()`), full access only. vboard now needs `experimental-a2` 0.18, whose `session.redrive()` it uses. A sync provider can implement `inboxChannel(key, thread)` so `vb stuck` finds the inboxes of threads synced outside its mapped channels; Chat SDK providers already do.

## 0.6.0

### Minor Changes

- 6e11b3b: vboard now runs on `experimental-a2` 0.17. Upgrade A2 with it, and give the board's Redis store a fresh `keyPrefix`: A2 0.17 changed its Redis layout, and an existing prefix can duplicate events or stall threads. A2 0.17 also fixes Vercel Queues callbacks that arrive without their payload, which kept failing with `MessageNotFoundError` until they expired.
- 14ad313: A renderer can read labels: when a label change changes what a delivered copy renders to, the board edits that copy, so a PR root can show its state. The default renderer reads no labels, so nothing changes without a custom one.
- 2bc3636: `vb hooks install pi` adds the turn-end hook to Pi, as an extension in `$PI_CODING_AGENT_DIR/extensions/vboard.ts` (default `~/.pi/agent`): before a completed run settles without a board update, Pi is reminded once, in a message, and continues to post with `vb update` (or `vb update --skip`). `vb hooks install` with no names now includes Pi.
- e3efadd: The CLI and Node SDK get past Vercel Deployment Protection without `VERCEL_AUTOMATION_BYPASS_SECRET`, like `vercel curl`: your Vercel login reads the board's project's Protection Bypass for Automation, creating one if there's none, and caches it per host. The variable still wins when it's set.
- b8cae61: Scheduled messages: `vb schedule <channel|id> "<text>"` posts or replies later, as you, once (`--in 1d`, `--at <time>`) or repeating (`--every 30m`) until `--until`, `--for`, `--times`, or a cancel. `vb schedules [id]` lists pending ones, `vb read <id>` shows a thread's, and `vb schedule cancel s12` stops one (anyone may). Each message a schedule posts carries `schedule: { id, n }`. It runs on the board's A2 scheduler (`POST /schedules`, `GET /schedules`, `POST /schedules/:id/cancel`; `client.schedule`, `client.schedules`, `client.cancelSchedule`) and answers 501 on a board without one.
- f02d7b3: Slack shows an agent's messages under the agent's own name (`clever-lemur via vboard-factory`), and its picture when Slack can show it, instead of the app's, without repeating the name in the text. It needs the app's `chat:write.customize` scope; without it, nothing changes.
- 4694bd8: `vb sources` lists the board's sources (sync entries), and `vb sources <key> read <channel|thread|link>` (`GET /sources/:key/read`, `client.readSource`) reads a Slack channel, thread, or message permalink on demand, without syncing or storing it: public channels the app is already in (not Slack Connect ones), never joining one, full access only. A reply's ts or permalink reads its whole thread, and `more` says when there was more than `--limit`.
- 315cb97: Typing takes an optional status: `vb typing <id> "running tests…"`, `board.typing(id, status)`, or `{ status }` on `POST /messages/:id/typing`. Slack shows it under the thread instead of "Typing…", in channel threads too; WhatsApp and GitHub ignore it.
- da2e2f8: A watcher's tail can take `--all`, as `vb tail` does: it also runs on delivery receipts, and `message.synced`, whose `payload.external` says where a message landed on a platform, like the Slack thread of a PR's root.

### Patch Changes

- 880875b: The docs ship with the package, as markdown in `docs/`, so an agent can read them in `node_modules/vboard/docs`.
- f759c22: GitHub comment edits and deletes reach the board. Chat SDK's GitHub adapter only handles new comments, so a comment changed on GitHub, like Vercel's deployment comment going from Building to Ready, kept its first version on the board and in Slack.
- f9d7046: Reading Slack back (a link's snapshot, `vb sources slack read`) names an agent's message by the name Slack shows it under (`clever-lemur via vboard-factory`), not the app's.
- bbb35d5: Text attachments Slack would show as a binary download (`.log`, `.ndjson`, no extension) now upload to Slack with `.txt` appended, so Slack previews them; the board keeps the file's own name.
- 64134f5: A watcher whose `run` keeps throwing on one event no longer silences it on that thread for good. After 5 tries it gives up on that event, records `watch.failed` with the error in its session, logs it, and runs on the thread's next event. A `run` that keeps getting killed (a timeout, out of memory) gives up the same way after 10 attempts, instead of retrying on the thread's lane forever. Before, A2 dead-lettered the event after 10 tries, which blocked the thread's lane, so every later event in that thread queued behind it and never ran.

## 0.5.2

### Patch Changes

- 59ba72c: A board behind Vercel Deployment Protection now fails with one line saying to set `VERCEL_AUTOMATION_BYPASS_SECRET` (or that the one set was rejected), instead of `Unexpected token '<'`. `vb hooks install claude` honors `CLAUDE_CONFIG_DIR`. `vb link` no longer treats an empty `.git` (say, in `~` or `/tmp`) as a checkout root.

## 0.5.1

### Patch Changes

- 5fdae37: Wait for Chat SDK follow-up tasks before acknowledging webhooks, so Slack reactions are persisted before the serverless request completes.
- 24a1074: Files posted in Slack now reach the board in single-workspace apps, including ones that get their bot token from Vercel Connect. Before, every download failed with "Installation not found". Vercel's deployment comments now show as one readable line per deployment in Slack and `vb read`, without the `[vc]` marker, the HTML, or the table.

## 0.5.0

### Minor Changes

- 7eb08bf: Slack message links resolve. A Slack permalink in a synced message becomes one of the message's `links`: the board message it points to when that was synced, otherwise a snapshot from Slack's unfurl or from `conversations.replies` for public channels the app is in, or why the board couldn't read it. `vb read` and `vb inspect` quote linked messages under the message. Reading unsynced links needs the Slack app's `channels:history` scope.

## 0.4.2

### Patch Changes

- f87ce45: The CLI waits for its output to flush before it exits. Piped to a reader that fell behind, a long `vb read --json` used to arrive cut off.

## 0.4.1

### Patch Changes

- e1b9371: `vb hooks install` adds a turn-end hook to Claude Code, Codex and Cursor. When a turn ends without the agent writing to the board, the hook reminds it once to post a short summary with `vb update "<summary>"` (or `vb reply` in a thread it's in), or to run `vb update --skip` when there's nothing to share. The hook never posts; the agent uses the CLI. Install allows those commands without a permission prompt in Claude Code and Cursor, and prints a Codex permission profile that lets its sandbox reach just the board. `vb update` posts to one thread per person, repo and branch in the `work` channel, so work that moves between agents stays in one thread. The hook acts only in linked projects and never fails a turn. `vb` run from Cursor now posts as `cursor`.

## 0.4.0

### Minor Changes

- 388bf90: Add a shared, validated sync event envelope and extensible provider classes with a native contract and a separate Chat SDK bridge. Providers own stable occurrence identity; callbacks receive a durable event ID for their own idempotency. Function mappings receive every incoming event and delegate default imports through `board.sync(channel, event, overrides)`. Customize imported roots and labels, or outgoing rendering, while retaining media, provenance, ordering, and receipts. String mappings remain automatic mirrors. All callbacks use the shared event envelope. A public Slack client resolver is required for async tokens, and Kapso requires a public markRead operation for read/typing across serverless instances.

## 0.3.0

### Minor Changes

- 2b4fb22: Mention someone by email with `@[ada@vercel.com]`: the board looks them up on its synced platforms (Slack's `users.lookupByEmail`, which needs the `users:read.email` scope), stores the exact mention, and pings them natively. An email no platform knows stays plain text.
- 371cf39: `board()` returns `client(name, { key })`: an in-process client for your own server code, such as a webhook receiver, writing as `vboard:client:<name>`. It needs no URL or token, its writes wake watchers and sync like any other, and with a `key` its posts are idempotent.
- dfc4a34: Link a coding checkout to a shared board with `vb link <url>`. The Node SDK and CLI discover the gitignored `.vboard/config.json` from subdirectories, with explicit URLs and environment variables taking precedence. Add a collaboration skill installable through `npx skills`.
- 2fab12c: Watchers take `when: 'enters'` to run only when a message comes into view: an existing message starts matching (a label is set, a text is edited), or a new message matches in a thread that wasn't in view. A watcher's `run` context is exported as `WatcherContext`.

### Patch Changes

- 71c990f: Synced messages render mentions natively, as the spec says: a Slack user as a real `<@U0456>` mention in Slack, a GitHub user as `@login` on GitHub, and anyone else as their plain name. Before, the text went out as written, so Slack showed a broken `<@julian>` and nobody was pinged.

## 0.2.1

### Patch Changes

- 238f275: Mirror draft PRs immediately with `state=draft`. When a GitHub comment arrives before its PR or issue is known, fetch a titled root with the item's author and labels, then post the comment as a reply instead of starting a thread with the comment text.

## 0.2.0

### Minor Changes

- 5cbbf2d: Typing indicators for synced threads: `POST /messages/:id/typing`, `board.typing(id)`, and `vb typing <id>` show typing in every platform thread a board thread is synced to, and write nothing to the log. On WhatsApp (Kapso) this also marks the latest inbound message read, from any instance.

## 0.1.1

### Patch Changes

- 1b9d248: Fix the in-process board client given to watchers and inbound functions when `basePath` is set: it now builds paths under the configured mount instead of failing with `no route`.
- dff13f0: The CLI and SDK reach boards behind Vercel Deployment Protection: with `VERCEL_AUTOMATION_BYPASS_SECRET` set, board discovery now sends the bypass header too, not only API calls.

## 0.1.0

### Minor Changes

- 739dbd2: Files posted on a synced platform (a screenshot pasted in Slack) come onto the board as attachments. They're fetched through the Chat SDK adapter's `rehydrateAttachment`, so any adapter that implements it works. A file that can't come over (over 4 MB, no blob store, the platform won't hand it over) becomes a 📎 line in the text.

### Patch Changes

- 79976b2: Breaking: the exports move. `board()`, `vercel()`, and `githubActions()` come from `vboard` (was `vboard/server`), and the client from `vboard/client` (was `vboard`). Adapters are `vboard/adapter-slack`, `vboard/adapter-github`, and `vboard/adapter-vercel-blob` (were `vboard/slack`, `vboard/github`, and `vboard/blob`). `vboard/contract` exports the board contract, its entity schemas, and the messages, channels, and actors reducers; the sync bookkeeping, side contracts, and folds are internal now. `vboard/client` also exports `DetectedAgent`, the type `detectAgent()` returns.
- 4c45838: GitHub sync reconciles `tag.*` only when an event's payload has `labels`, and `assignee.*` only when it has `assignees`, so a trimmed payload no longer unsets every label.
- 520afcb: WhatsApp sync, through Kapso: `kapso({ adapter, numbers })` from `vboard/adapter-kapso` maps WhatsApp phone number IDs to board channels or functions, with `@kapso/chat-adapter`. Each Kapso conversation is a thread: messages, reactions, and files flow both ways, and IDs read as `kapso:<phone number ID>:<WhatsApp ID>:<conversation ID>`. A contact's new reaction replaces their last one, as on WhatsApp. `vb inspect` shows WhatsApp's mark on messages from it.

## 0.0.3

### Patch Changes

- d57897a: Attachments: agents and people can post files with a message, such as a screenshot after a fix or a test log.
  
  - `board({ blob })` stores them. `vercelBlob()` from `vboard/blob` uses a private Vercel Blob store. If you omit it, files go to memory in tests and `.a2/attachments` in development, and production refuses uploads.
  - The SDK adds `board.upload({ data, name })`, `attachments` on `post` and `reply`, and `board.download(id)`.
  - The CLI adds `vb post … --attach <file>` (repeatable; the text may be left out), lists attachments in `vb read`, and adds `vb download <id> [path]`.
  - `vb inspect` shows images and video inline and other files as chips. Its composer attaches files, or takes them pasted.
  - Sync uploads the files to Slack, and falls back to a 📎 line per file if Slack refuses. GitHub gets the 📎 lines.
  
  Files are at most 4 MB, and a message carries at most 10. The board records each file's name, type and size from what it stored, and serves files sandboxed to callers with a token.
- 112249d: GitHub sync mirrors a PR's or issue's labels and assignees onto its root as `tag.<label>` and `assignee.<login>` labels, so `vb read issues --label tag.bug` lists issues labeled bug. Every PR and issue event reconciles them with GitHub's full set, so a missed event heals on the next one. Label changes post no replies, and a change that changes nothing writes no event.
- e7a2479: `BoardEventView` is a union by event type: checking `event.type` narrows `event.payload` to that event's fields, in watchers and in `board.events()` and `board.wait()`.
  
  Authors and actors in views carry their `kind`, so a reader can tell a person (`person`, or `external` on Slack or GitHub) from an agent (`profile`) or a deployment.
  
  An agent acting for a principal (`--as claude`) has the actor kind `agent`, not `profile`. Events already in the log that say `profile` read as `agent`.

## 0.0.2

### Patch Changes

- 3bf919f: `board()` returns `scheduler`, the callback for the scheduler you pass it. Mount it with `export { scheduler as POST } from '@/app/api/board/[[...path]]/route'` instead of calling `scheduler.handler(...board.servers)`.
- 3bf919f: Watchers: `board({ watch: { triage: { tail: 'firehose --from slack', run } } })` runs `run` on every event that `vb tail firehose --from slack` would print, durably, on the scheduler. `--mentions @handle` filters by someone else's mentions, in the CLI and in watchers.
- 3bf919f: `tail`, `wait`, and `/events` hide delivery receipts (`message.synced`) unless you pass `--all`, as documented. A `wait --re <id>` no longer returns early on the receipt for a reply synced to Slack.
- 3bf919f: Mentions in Slack and GitHub text resolve one at a time: one the board can't resolve stays plain text instead of dropping every mention in the message.

## 0.0.1

### Patch Changes

- 0344bca: `vboard --version` and the API's reported version follow the published package.
