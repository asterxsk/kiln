# extensions

## Purpose
Each subfolder is a self-contained pi extension. Pi auto-loads any `extensions/<name>/index.ts` (or `extensions/<name>/package.json` with a `pi.extensions` field).

## Ownership
- Modular extension system for Pi.
- Registration, integration, and architecture patterns across all extensions.

## Local Contracts
- **Independence**: Each extension folder is self-contained — no extension imports from a sibling.
- **Bridges**: Cross-extension integration uses `globalThis` bridges (e.g., `globalThis.__pi_copilot_usage`, `globalThis.__pi_goal_state`). Bridge keys are prefixed with `__pi_` and unique per extension.
- **NPM dep safety**: Every extension with npm dependencies must guard all top-level requires/imports in a try/catch. Missing deps log a warning, register with `status: "degraded"` or `status: "disabled"`, and return early rather than crashing Pi.
- **Graceful degradation**: When an extension's peer is missing, it degrades gracefully. Widgets and commands from other extensions continue working.
- **Self-contained rendering**: Extensions include their own components (e.g., `CompactToolBox`) rather than importing from a shared extension to avoid tight coupling.
- **UI Primitives**: Extensions use `ctx.ui` methods (`setHeader`, `setFooter`, `setWidget`, `notify`, `custom`, `select`, `input`) independently.

## Work Guidance
- **Adding an extension**: 
  1. Create a new folder `extensions/<name>/`
  2. Add an `index.ts` with a default export that receives `pi: ExtensionAPI`
  3. Add an `AGENTS.md` explaining purpose, API surface, and how to remove
  4. Update the Child DOX Index in this file
  - If npm deps are needed, add `"pi": { "extensions": ["./index.ts"] }` to `package.json` and run `npm install`.
  - **All npm imports must be guarded**: wrap `require()` or dynamic `import()` in a try/catch at the top of `index.ts` (or call a lazy init function). If the dep is missing, log a warning, register with `status: "disabled"` (if non-optional) or `status: "degraded"` (if partial functionality), and return early. See `filechanges`, `artifacts`, and `pi-hermes-memory` for reference patterns.
- **Feature Registration Pattern**: To make the LLM aware of a new extension, add a registration call at the top of its `default export`:
  ```ts
  export default function (pi: ExtensionAPI) {
    (globalThis as any).__pi_extension_features?.push({
      name: "my-extension",
      description: "What it does — shown in system prompt",
      commands: ["/cmd1"],
      tools: ["tool1"],
      shortcuts: ["Ctrl+X"],
    });
  }
  ```
- **Removing an extension**: Delete the folder. Tools/commands/shortcuts will disappear automatically, and peers will degrade gracefully.

## Verification
- Extensions should load automatically via `index.ts` or `package.json`.
- Missing peer extensions should not crash the host extension (verify graceful degradation).
- New extensions should appear in the system prompt under `## Loaded Extensions` if properly registered.

## Child DOX Index
- `agentzero/` — `/init` command (create or audit AGENTS.md) and global AGENTS.md injection into system prompt
- `artifacts/` — `create_artifact`, `scaffold_artifact`, `render_artifact`, `list_artifacts`, `delete_artifact`, and `check_artifact` tools + `/artifacts` command: save/browse standalone html/md artifacts, opening html in the default browser (with WSL support) and md in a fullscreen reader (with line numbers, arrow cursor selection, inline commenting, and review submission)
- `compactui/` — Compact tool rendering, responsive wrapping, assistant time tracking footer, tagged thinking dimming, tool status dot, and auto-hide notifications (3s).
- `context/` — `/context` overlay: token grid breakdown with per-category color-coded visualization
- `destructive/` — confirms before running deletion commands (`rm`, `del`, `git rm`, `git clean -f`, …): Allow/Deny prompt, blocks by default with no UI
- `ferment/` — Structured delivery framework (scope, phases, steps) for long-running agent tasks
- `9router-provider/` — Local/remote 9router AI gateway provider with auto-discovered models and `/login` integration
- `filechanges/` — `/filechanges` overlay + accept/decline; tracks file modifications per session and exposes counts for the ui-customization footer
- `goal/` — `/goal` command — autonomous task orchestrator with pause/resume, turn tracking, history
- `header/` — Banner header: ASCII art on the left, provider/model/version info panel on the right
- `instruct/` — Custom system instructions: shell preference, task tracking, no emojis, plan mode guidelines
- `perms/` — Permissions manager and checklist (`/extensions`), plus plan mode (`/plan`, `plan` tool with strict disabling of `write`/`edit`/`bash` tools)
- `pi-hermes-memory/` — Persistent memory system with MEMORY.md, SQLite, session search, skill storage, auto-consolidation
- `powershell/` — `powershell` tool (LLM-callable) with compactui-style rendering
- `questions/` — `questions` tool (multi-choice TUI with optional custom-answer fallback and ASCII sketches)
- `spinner/` — Animated star spinner with theme-aware accent color, glow effect, and fun phrases
- `ui-customization/` — Gradient ASCII header banner + status footer showing provider, model, token I/O, context usage, git branch, worktree, file changes; Alt+C compact shortcut; theme removal
- `subagents/` — the `subagent`/`subagent_resume`/`subagent_interrupt` tools + `/sub` and `/jobs` commands: spawn isolated pi processes with predefined agent .md files. Runs in the BACKGROUND — returns a job id immediately and pings the agent with a follow-up message when the job finishes. Agents can be `interactive` (pause between phases, resumable) and use `session: fork|lineage` to inherit or trace parent context
- `tasks/` — `/manage_task` command — background terminal task runner with output capture, wait, cancel; persists across sessions
- `timers/` — `/schedule` command — one-shot and repeating timers with notifications, auto-delete on fire, and overlay browser
- `todo/` — `todo` tool + `/todos` command — structured task list with status tracking, categories, reminders, and persistent overlay widget
- `video-extract/` — `video_extract` tool: YouTube + local video content extraction via Gemini API, ffmpeg, and yt-dlp

