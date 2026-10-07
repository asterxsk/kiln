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
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectMemoryDir } from "./src/paths.ts";
import { renderMemoryBlock } from "./src/prompt.ts";
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

	pi.on("session_start", async (_event, ctx) => {
		dirs.project = projectMemoryDir(ctx.cwd);
		snapshot = renderMemoryBlock(store.loadAll());
	});

	pi.on("before_agent_start", async (event) => {
		if (!snapshot) return;
		event.systemPromptOptions.sections[MEMORY_SECTION] = snapshot;
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
}
