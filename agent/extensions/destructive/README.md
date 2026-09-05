# destructive

Asks before running destructive (deletion) commands.

## What it does

Intercepts `bash` / `powershell` tool calls and prompts:

```text
Do you want to allow pi to run:
{destructive-part(s) only}

1. Allow
2. Deny
```

Only the destructive segment(s) are shown — e.g. `echo hi && rm -rf /tmp/foo`
prompts with just `rm -rf /tmp/foo`.

Anything other than **Allow** — including Deny or dismissing with Esc —
blocks the command. In non-interactive mode (no UI) deletion commands are
blocked by default.

## Blocked commands

| Group | Matches |
|---|---|
| File deleters | `rm`, `rmdir`, `unlink`, `shred`, `del`, `erase`, `rd`, `remove-item`, `ri` (plus `sudo`/`doas` prefixes, full paths, compound commands split on `&&`, `\|\|`, `;`, `\|`, newlines) |
| Destructive git | `git rm`, `git branch -d/-D/--delete`, `git tag -d/--delete`, `git push -d/-D/--delete`, `git push <remote> :<branch>`, `git stash drop/clear`, `git clean` with `-f`, `git worktree remove`, `git notes remove/prune` |

## Files

- `index.ts` — `tool_call` hook, command matching (`isDestructiveCommand` / `getDestructiveSegments`), confirm prompt, `/destructive` toggle command
- `README.md` — this file
