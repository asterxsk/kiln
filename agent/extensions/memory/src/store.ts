import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Bounded, curated cross-session memory, cloned from the Hermes Agent framework.
 *
 * Memory is addressed by two axes:
 *   - scope  → where it lives: `global` (shared across projects) or `project`
 *              (specific to the current working directory).
 *   - target → what it holds: `memory` (the agent's own notes) or `user`
 *              (the user profile).
 *
 * Each (scope, target) pair is one markdown file — GLOBAL MEMORY.md / USER.md
 * under `~/.pi/agent/memories/`, PROJECT MEMORY.md / USER.md under
 * `<project>/.pi/memories/`.
 *
 * Entries are separated by a line containing only `§`. Each file has a hard
 * character budget and never auto-compacts: a write that would overflow is
 * rejected so the agent makes room itself.
 */

export type MemoryTarget = "memory" | "user";
export type MemoryScope = "global" | "project";

export const ENTRY_SEPARATOR = "\n§\n";

export const SCOPES: readonly MemoryScope[] = ["global", "project"];
export const TARGETS: readonly MemoryTarget[] = ["memory", "user"];

interface StoreSpec {
	file: string;
	limit: number;
	labels: Record<MemoryScope, string>;
}

const STORES: Record<MemoryTarget, StoreSpec> = {
	memory: {
		file: "MEMORY.md",
		limit: 2200,
		labels: {
			global: "MEMORY (your personal notes)",
			project: "PROJECT MEMORY (this project's notes)",
		},
	},
	user: {
		file: "USER.md",
		limit: 1375,
		labels: {
			global: "USER PROFILE",
			project: "PROJECT USER PROFILE (this project's preferences)",
		},
	},
};

/** The two directories memory can live in. `project` is resolved per session. */
export interface MemoryDirs {
	global: string;
	project: string;
}

export function labelFor(scope: MemoryScope, target: MemoryTarget): string {
	return STORES[target].labels[scope];
}

/** Raised for any user-correctable memory failure (bad args, no match, overflow). */
export class MemoryError extends Error {}

export interface StoreState {
	scope: MemoryScope;
	target: MemoryTarget;
	label: string;
	entries: string[];
	used: number;
	limit: number;
	percent: number;
}

function measure(entries: string[]): number {
	return entries.join(ENTRY_SEPARATOR).length;
}

function parse(raw: string): string[] {
	const text = raw.replace(/\r\n/g, "\n");
	if (!text.trim()) return [];
	return text
		.split(/\n§\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export class MemoryStore {
	private readonly dirs: MemoryDirs;

	/** Holds the `dirs` object by reference, so a later `dirs.project` update is seen. */
	constructor(dirs: MemoryDirs) {
		this.dirs = dirs;
	}

	pathFor(scope: MemoryScope, target: MemoryTarget): string {
		return path.join(this.dirs[scope], STORES[target].file);
	}

	load(scope: MemoryScope, target: MemoryTarget): string[] {
		const file = this.pathFor(scope, target);
		if (!fs.existsSync(file)) return [];
		return parse(fs.readFileSync(file, "utf8"));
	}

	/** Global stores first, then project stores, so the more specific ones read last. */
	loadAll(): StoreState[] {
		const states: StoreState[] = [];
		for (const scope of SCOPES) {
			for (const target of TARGETS) {
				states.push(this.state(scope, target));
			}
		}
		return states;
	}

	state(scope: MemoryScope, target: MemoryTarget, entries = this.load(scope, target)): StoreState {
		const spec = STORES[target];
		const used = measure(entries);
		return {
			scope,
			target,
			label: spec.labels[scope],
			entries,
			used,
			limit: spec.limit,
			percent: Math.round((used / spec.limit) * 100),
		};
	}

	add(scope: MemoryScope, target: MemoryTarget, content: string): StoreState {
		const entry = content.trim();
		if (!entry) throw new MemoryError("`content` is required for add.");
		const entries = this.load(scope, target);
		const used = measure(entries);
		const next = entries.length === 0 ? entry.length : used + ENTRY_SEPARATOR.length + entry.length;
		this.assertFits(scope, target, next, `adding ${entry.length} chars`);
		entries.push(entry);
		this.save(scope, target, entries);
		return this.state(scope, target, entries);
	}

	replace(scope: MemoryScope, target: MemoryTarget, oldText: string, content: string): StoreState {
		const entry = content.trim();
		if (!entry) throw new MemoryError("`content` is required for replace.");
		const entries = this.load(scope, target);
		const index = this.locate(scope, target, entries, oldText);
		const next = [...entries];
		next[index] = entry;
		this.assertFits(scope, target, measure(next), `replacing with ${entry.length} chars`);
		this.save(scope, target, next);
		return this.state(scope, target, next);
	}

	remove(scope: MemoryScope, target: MemoryTarget, oldText: string): StoreState {
		const entries = this.load(scope, target);
		const index = this.locate(scope, target, entries, oldText);
		const next = entries.filter((_, i) => i !== index);
		this.save(scope, target, next);
		return this.state(scope, target, next);
	}

	/** Locate exactly one entry by unique substring (a whole-entry match wins outright). */
	private locate(scope: MemoryScope, target: MemoryTarget, entries: string[], oldText: string): number {
		const key = oldText.trim();
		if (!key) throw new MemoryError("`old_text` is required.");
		const exact = entries.indexOf(key);
		if (exact !== -1) return exact;
		const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(key));
		if (matches.length === 0) {
			throw new MemoryError(`No entry in ${labelFor(scope, target)} matches "${key}".`);
		}
		if (matches.length > 1) {
			throw new MemoryError(`"${key}" matches ${matches.length} entries; use a more specific old_text.`);
		}
		return matches[0].index;
	}

	private assertFits(scope: MemoryScope, target: MemoryTarget, nextLength: number, action: string): void {
		const spec = STORES[target];
		if (nextLength > spec.limit) {
			throw new MemoryError(
				`${labelFor(scope, target)} would be ${nextLength}/${spec.limit} chars after ${action} ` +
					`(over by ${nextLength - spec.limit}). Memory does not auto-compact: ` +
					`consolidate or remove entries, then retry.`,
			);
		}
	}

	private save(scope: MemoryScope, target: MemoryTarget, entries: string[]): void {
		fs.mkdirSync(this.dirs[scope], { recursive: true });
		const body = entries.length ? `${entries.join(ENTRY_SEPARATOR)}\n` : "";
		fs.writeFileSync(this.pathFor(scope, target), body, "utf8");
	}
}
