import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderStore } from "./prompt.ts";
import { MemoryError, MemoryStore, type MemoryScope, type MemoryTarget, type StoreState } from "./store.ts";

const ACTIONS = ["add", "replace", "remove"] as const;
const SCOPES = ["global", "project"] as const;
const TARGETS = ["memory", "user"] as const;

interface MemoryArgs {
	action: (typeof ACTIONS)[number];
	scope: MemoryScope;
	target?: MemoryTarget;
	content?: string;
	old_text?: string;
}

function applyAction(store: MemoryStore, scope: MemoryScope, target: MemoryTarget, args: MemoryArgs): StoreState {
	switch (args.action) {
		case "add":
			if (typeof args.content !== "string") throw new MemoryError("`content` is required for add.");
			return store.add(scope, target, args.content);
		case "replace":
			if (typeof args.content !== "string") throw new MemoryError("`content` is required for replace.");
			if (typeof args.old_text !== "string") throw new MemoryError("`old_text` is required for replace.");
			return store.replace(scope, target, args.old_text, args.content);
		case "remove":
			if (typeof args.old_text !== "string") throw new MemoryError("`old_text` is required for remove.");
			return store.remove(scope, target, args.old_text);
	}
}

function summary(state: StoreState): string {
	const noun = state.entries.length === 1 ? "entry" : "entries";
	return `${state.label}: ${state.entries.length} ${noun}, ${state.used}/${state.limit} chars (${state.percent}%).`;
}

export function createMemoryTool(store: MemoryStore) {
	return defineTool({
		name: "memory",
		label: "Memory",
		description:
			"Persist durable facts across sessions. Two independent axes. " +
			"scope: 'global' for facts that hold everywhere (user preferences, machine/environment, " +
			"cross-project conventions) or 'project' for facts about the current working directory " +
			"(this repo's structure, commands, conventions, gotchas). " +
			"target: 'memory' for your own notes (2,200 chars) or 'user' for the user profile " +
			"(1,375 chars). Actions: add, replace, remove. " +
			"Both scopes are injected into the system prompt at session start, so there is no read action.",
		promptSnippet: "Save durable notes or user preferences across sessions (global or project scope)",
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description: "add a new entry, replace an existing one, or remove one",
			}),
			scope: StringEnum(SCOPES, {
				description:
					"Where the entry belongs: 'global' (applies everywhere) or 'project' (specific to the current project).",
			}),
			target: Type.Optional(
				StringEnum(TARGETS, {
					description: "'memory' (agent notes) or 'user' (user profile). Default 'memory'.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description:
						"Entry text for add/replace. For replace, the complete new entry — old_text only locates it.",
				}),
			),
			old_text: Type.Optional(
				Type.String({ description: "A unique substring identifying the entry for replace/remove." }),
			),
		}),

		async execute(_toolCallId, params) {
			const scope: MemoryScope = params.scope;
			const target: MemoryTarget = params.target ?? "memory";
			try {
				const state = applyAction(store, scope, target, params);
				return {
					content: [{ type: "text" as const, text: `${summary(state)}\n\n${renderStore(state)}` }],
					details: { scope, target, action: params.action, entries: state.entries.length, used: state.used },
				};
			} catch (error) {
				if (error instanceof MemoryError) throw new Error(error.message);
				throw error;
			}
		},
	});
}
