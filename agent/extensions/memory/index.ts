/**
 * memory — bounded, curated cross-session memory for Pi.
 *
 * Cloned from the Hermes Agent memory framework, extended with a scope axis:
 *   - global  → `~/.pi/agent/memories/`   (facts that hold across projects)
 *   - project → `<project>/.pi/memories/` (facts about the current project)
 *
 * Each scope has the two Hermes stores (MEMORY.md for the agent's notes,
 * USER.md for the user profile), char-limited and edited through the memory
 * tool. All stores are rendered into the system prompt as a frozen snapshot at
 * session start, so the prompt prefix stays cache-stable for the whole session;
 * writes land on disk immediately but only appear in the prompt next session.
 *
 * Tool:
 *   memory(action, scope, target?, content?, old_text?)   add | replace | remove
 *
 * Command:
 *   /memory   show usage and entry counts for every store
 *   /memory-auto on|off   toggle end-of-response memory reflection
 *
 * Reflection: when a user turn finishes having done real work, the boundary hook
 * gives the same agent one extra request to review the conversation and save
 * durable facts through the memory tool. See src/reflect.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectMemoryDir } from "./src/paths.ts";
import { renderMemoryBlock } from "./src/prompt.ts";
import { reflectionDraft, shouldReflect } from "./src/reflect.ts";
import { MemoryStore, type MemoryDirs } from "./src/store.ts";
import { createMemoryTool } from "./src/tool.ts";

const MEMORY_SECTION = "memory";

export default function memoryExtension(pi: ExtensionAPI) {
	const dirs: MemoryDirs = {
		global: join(homedir(), ".pi", "agent", "memories"),
		project: projectMemoryDir(process.cwd()),
	};
	const store = new MemoryStore(dirs);
	let snapshot = "";
	// End-of-response reflection state, reset for each user turn.
	let reflectEnabled = true;
	let reflectDone = false;
	let workedThisRun = false;
	let usedMemoryThisRun = false;

	pi.on("session_start", async (_event, ctx) => {
		dirs.project = projectMemoryDir(ctx.cwd);
		snapshot = renderMemoryBlock(store.loadAll());
	});

	pi.on("before_agent_start", async (event) => {
		if (!snapshot) return;
		event.systemPromptOptions.sections[MEMORY_SECTION] = snapshot;
	});

	// A new user turn resets reflection state. `before_agent_start` fires once per
	// user prompt and never for a boundary continuation, so this both allows one
	// reflection per turn and keeps the injected continuation from looping.
	pi.on("before_agent_start", () => {
		reflectDone = false;
		workedThisRun = false;
		usedMemoryThisRun = false;
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "memory") usedMemoryThisRun = true;
		else workedThisRun = true;
	});

	pi.on("agent_before_settle", (event) => {
		if (
			!shouldReflect({
				enabled: reflectEnabled,
				done: reflectDone,
				outcome: event.outcome,
				worked: workedThisRun,
				usedMemory: usedMemoryThisRun,
			})
		) {
			return;
		}
		reflectDone = true;
		return { continue: true, entries: [...event.entries, reflectionDraft()] };
	});

	pi.registerTool(createMemoryTool(store));

	pi.registerCommand("memory", {
		description: "Show persistent memory usage and entry counts (global and project)",
		handler: async (_args, ctx) => {
			const lines = store.loadAll().map((state) => {
				const noun = state.entries.length === 1 ? "entry" : "entries";
				return `[${state.scope}] ${state.label} — ${state.entries.length} ${noun}, ${state.used}/${state.limit} chars (${state.percent}%)`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("memory-auto", {
		description: "Toggle end-of-response memory reflection (on|off)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") reflectEnabled = true;
			else if (arg === "off") reflectEnabled = false;
			else if (arg) {
				ctx.ui.notify("Usage: /memory-auto on|off", "warning");
				return;
			} else reflectEnabled = !reflectEnabled;
			ctx.ui.notify(`Memory reflection is ${reflectEnabled ? "on" : "off"}`, "info");
		},
	});
}
