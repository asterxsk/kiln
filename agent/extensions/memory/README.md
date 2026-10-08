# memory

Bounded, curated cross-session memory for Pi — cloned from the memory framework
that [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
uses, extended with a global/project scope axis.

Memory is a small, hand-edited knowledge base the agent curates over time. It
lives in char-limited markdown files and is injected into the system prompt so
the agent starts every session already knowing your environment, your
preferences, and how this project works.

## The framework

Two independent axes:

- **scope** — where memory lives:
  - `global` → `~/.pi/agent/memories/` — facts that hold across all projects.
  - `project` → `<projectRoot>/.pi/memories/` — facts about the current project.
    The project root is the nearest ancestor of the working directory containing
    a `.git` entry (a directory, or a file for worktrees/submodules), so starting
    pi from a subdirectory still writes to one project store. With no repository,
    it falls back to the working directory itself.
- **target** — what memory holds:
  - `memory` → `MEMORY.md` — the agent's own notes (environment, conventions, lessons).
  - `user` → `USER.md` — the user profile (preferences, communication style, expectations).

Every (scope, target) pair is one file with its own budget, mirroring Hermes:

| Scope | Target | File | Purpose | Char limit |
|---|---|---|---|---|
| global | `memory` | `~/.pi/agent/memories/MEMORY.md` | Agent's cross-project notes | 2,200 |
| global | `user` | `~/.pi/agent/memories/USER.md` | User profile | 1,375 |
| project | `memory` | `<projectRoot>/.pi/memories/MEMORY.md` | Notes about this project | 2,200 |
| project | `user` | `<projectRoot>/.pi/memories/USER.md` | Project-specific preferences | 1,375 |

No store auto-compacts: a write that would exceed its limit is rejected, and the
agent has to consolidate or remove entries itself.

**Choosing a scope is the agent's call.** The tool description instructs it to
use `global` for facts that hold everywhere (user preferences, machine and
environment, cross-project conventions) and `project` for facts tied to the
current working directory (repo structure, commands, conventions, gotchas).

Entries are separated by a line containing only `§`, and each store is rendered
into the prompt under a banner that shows its scope-tagged label and live usage:

```
══════════════════════════════════════════════MEMORY (your personal notes) [19% — 412/2,200 chars]══════════════════════════════════════════════
Runs on Windows 11
§
Prefers pnpm over npm

══════════════════════════════════════════════USER PROFILE [2% — 21/1,375 chars]══════════════════════════════════════════════
Prefers terse answers

══════════════════════════════════════════════PROJECT MEMORY (this project's notes) [1% — 17/2,200 chars]══════════════════════════════════════════════
Build: pnpm build
```

**Frozen snapshot.** The prompt block is captured once at `session_start` and
never changes mid-session, keeping Pi's prompt prefix cache-stable. Tool writes
hit disk immediately and appear in the prompt on the **next** session.

## Tool

The agent manages memory with a single tool:

```
memory(action, scope, target?, content?, old_text?)
```

| Action | Required params | Behavior |
|---|---|---|
| `add` | `scope`, `content` | Append a new entry. |
| `replace` | `scope`, `old_text`, `content` | Replace the whole entry located by a unique `old_text`. |
| `remove` | `scope`, `old_text` | Delete the entry located by a unique `old_text`. |

- `scope` is `global` or `project` and is required, so the agent consciously
  decides where each fact belongs.
- `target` is `memory` (default) or `user`.
- There is no `read` action — memory arrives in the system prompt automatically.
- `old_text` is a short unique substring, not the full entry. A whole-entry match
  wins over substring matches; if the substring matches several entries, the tool
  asks for a more specific one. Matching is scoped to one file.
- `replace` overwrites the entire matched entry, so `content` must be the complete
  new entry.

### When a store is full

The tool returns an error instead of silently dropping entries, so the agent makes
room in the same turn (consolidating or removing) and retries.

## Reflection

When a user turn finishes having done real work — at least one tool call other
than `memory`, and no memory written during the run — the extension gives the
**same agent** one extra request to review the conversation and save anything
durable through the `memory` tool. It is the same session and context, not a
subagent. A pure Q&A turn is skipped, and each user turn reflects at most once,
so the injected continuation cannot loop. The nudge itself is a hidden custom
message (`display: false`); the system-prompt snapshot stays frozen.

## Command

| Command | Action |
|---|---|
| `/memory` | Show usage and entry counts for all four stores. |
| `/memory-auto on\|off` | Toggle end-of-response reflection for the session (default on). |

## Layout

```
memory/
  index.ts          factory: session scope resolution, frozen snapshot, prompt
                    injection, /memory command
  src/store.ts      MemoryStore — bounded add/replace/remove across both scopes
  src/paths.ts      project-root discovery (nearest .git) + project memory dir
  src/prompt.ts     Hermes-style banner + § rendering
  src/tool.ts       the memory tool definition
  src/reflect.ts    end-of-response reflection gate + injected instruction
  src/*.test.ts     unit tests for the store, renderer, path resolver, and gate
  install.sh/.ps1   per-extension dependency installer
```

## Development

```sh
node --test --experimental-strip-types src/store.test.ts src/prompt.test.ts src/paths.test.ts
```

Add `~/.pi/agent/memories/` (global) or `<projectRoot>/.pi/memories/` (project)
to `.gitignore` if you don't want local notes committed.
