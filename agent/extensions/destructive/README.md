# destructive

Asks before running destructive (deletion) commands.

## What it does

Intercepts `bash` / `powershell` tool calls and prompts:

```text
Do you want to allow pi to run:
{destructive segment(s) only}

1. Allow
2. Deny
```

Only the destructive segment(s) of a compound command are shown. Given a long
multi-line script, it collapses to just the `rm`/`git` line that triggered the
guard, e.g. `cd repo && npm ci && rm -rf build && git status` prompts with just
`rm -rf build`.

Anything other than **Allow** — including Deny or dismissing with Esc —
blocks the command. In non-interactive mode (no UI) deletion commands are
blocked by default.

## Toggle

Run `/destructive` to flip the guard on or off for the current session. It
starts enabled and resets to enabled when pi restarts, so the safe state is
the default.

## Blocked commands

| Group | Matches |
|---|---|
| File deleters | `rm`, `rmdir`, `unlink`, `shred`, `del`, `erase`, `rd`, `remove-item`, `ri` (plus `sudo`/`doas` prefixes, full paths, compound commands split on `&&`, `\|\|`, `;`, `\|`, newlines) |
| Destructive git | `git rm`, `git branch -d/-D/--delete`, `git tag -d/--delete`, `git push -d/-D/--delete`, `git push <remote> :<branch>`, `git stash drop/clear`, `git clean` with `-f`, `git worktree remove`, `git notes remove/prune` |
| Change-abandoning git | `git reset --hard`, `git restore` (unless `--staged` only), `git checkout -- <path>`, `git checkout .`, `git checkout -f` |

## Files

- `index.ts` — `tool_call` hook, command matching (`isDestructiveCommand`, `findDestructiveSegments`), confirm prompt, `/destructive` toggle
- `index.test.ts` — `node --test` suite for matching, segment extraction, the prompt, and the toggle
- `README.md` — this file
