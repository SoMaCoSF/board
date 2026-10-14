# Agent hooks

## Sub-features

- `vb hooks [status]`: whether each agent (Claude Code, Codex, Cursor, Pi) has the turn-end hook.
- `vb hooks install [agent...]`: writes the hook into the agent's config and allow rules for
  `reply`, `post`, `read`, and `channels` (Claude Code), printing one block per agent.
- `vb hooks uninstall [agent...]`: removes both.
- `vb hook stop --agent <agent>`: what the hook runs; reads the agent's JSON on stdin and, once per
  turn without a board update in a linked project, prints a reminder.

## How to get to it (user POV)

In a project linked to a board: `vb hooks install claude`, then `vb hooks status`.

## Driving it with the sandbox

Always in a throwaway `HOME`, so the sandbox user's real config stays clean:

```bash
$V/sh.sh "$S" 'H=$(mktemp -d); HOME=$H vb hooks status; HOME=$H vb hooks install claude
  HOME=$H vb hooks status claude; cat $H/.claude/settings.json; HOME=$H vb hooks uninstall claude'
```

Seen in a sandbox:

```
Claude Code  ~/.claude/settings.json
  added the turn-end hook
  reply, post, read, and channels run without asking

The hooks remind once per turn without a board update.
They stay quiet outside projects linked with `vb link <url>`.
Claude Code  installed  ~/.claude/settings.json
```

`settings.json` gets a `Stop` hook running `vb hook stop --agent claude 2>/dev/null || true` and
`Bash(vb reply:*)`-style allow rules.

The stop hook itself (the project at `/vercel/proj` is linked by `vb serve`):

```bash
$V/sh.sh "$S" 'H=$(mktemp -d); echo "{\"session_id\":\"s1\",\"cwd\":\"/vercel/proj\"}" | HOME=$H vb hook stop --agent claude'
```

On a turn with no board update it prints
`{"decision":"block","reason":"You didn't update the team's board (vboard) this turn. …"}`.

## Gotchas

- The command written into the hook depends on how `vb` was found: plain `vb` when the `vb` on
  PATH is this CLI (the sandbox's `/vercel/bin/vb` symlink is), else `node /abs/path/cli.mjs`,
  and `npx -y vboard@<version>` when run through npx. Check the mode you're verifying.
- `CODEX_HOME` and `XDG_CONFIG_HOME` move other agents' files; set them inside the throwaway
  `HOME` too when verifying Codex.
- `hook stop` stays silent outside a linked project or with no session id; that's correct, not a
  failure.
