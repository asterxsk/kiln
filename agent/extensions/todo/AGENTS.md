# Todo Extension

## Purpose
Provides a persistent todo list with overlay widget, slash command, and LLM-callable tool. Todos are tracked across sessions and displayed in a dedicated UI overlay. Supports i18n via optional `@juicesharp/rpiv-i18n` SDK.

## Ownership
- `index.ts` — extension entry, event handlers, overlay lifecycle
- `todo.ts` — todo tool and command registration
- `todo-overlay.ts` — TUI overlay widget for todo display
- `state/` — state management, replay, i18n bridge

## Local Contracts
- Registers tool: `todo` (tool name preserved for session history compatibility)
- Registers command: `/todos`
- Widget key: `rpiv-todos` (preserved for compatibility)
- State replayed from branch on `session_start`, `session_compact`, `session_tree`
- `replaceState(sessionId, state)` and `replayFromBranch()` from state modules — the store is keyed by `ctx.sessionManager.getSessionId()` so each session (main or in-process subagent) has an independent todo cell; `dropState(sessionId)` on `session_shutdown` prunes ended sessions
- Handles stale ctx errors during auto-compaction gracefully
- Batch items support `as` labels (on create) and `refs` (on subsequent items) for creating and referencing tasks in one call

## Work Guidance
- Todo state is session-branch-based and replayed on session events
- Overlay constructed lazily at first `session_start` with UI
- `hideCompletedTasksFromPreviousTurn()` called on `agent_start`
- i18n strings registered once at module init (soft optional peer dependency)
- Auto-clear: when no active tasks remain (all completed, deleted, or empty), the state resets to empty automatically at `agent_end` and after replay on `session_start`/`session_compact`/`session_tree`. This prevents stale completed tasks from persisting across turns. The clear is in-memory only — session lifecycle handlers re-apply it after branch replay so the empty state survives compaction and session transitions.
- Tool execution triggers overlay update via `tool_execution_end` event
- Overlay indentation: task prefix is `"   └ "` (first line, └ at col 3) and `"     "` (continuation, text at col 5), and the overflow summary line also starts with `"   └"`. This aligns the `└` tree glyph one column after the first letter of the spinner phrase (the spinner occupies 2 columns, e.g. `"✻ "`), so the todo overlay sits under the phrase rather than under the spinner animation character

## Verification
- Add todo: use `/todos` command or `todo` tool
- Verify overlay: check widget displays in TUI
- Test session persistence: `/new` then verify todos still shown
- Test compaction: trigger compact, verify todos replay correctly
- Trigger the agent spinner with at least one todo visible; confirm the `└` glyph in each todo line (and the `+N more` summary line) sits ONE COLUMN AFTER the first letter of the spinner phrase — not under the spinner animation character itself

## Child DOX Index
None
