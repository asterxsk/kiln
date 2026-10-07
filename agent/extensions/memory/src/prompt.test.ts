import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMemoryBlock, renderStore } from "./prompt.ts";
import { ENTRY_SEPARATOR, type StoreState } from "./store.ts";

function state(overrides: Partial<StoreState>): StoreState {
	return {
		scope: "global",
		target: "memory",
		label: "MEMORY (your personal notes)",
		entries: [],
		used: 0,
		limit: 2200,
		percent: 0,
		...overrides,
	};
}

test("renders a banner with the label and usage, joining entries with the delimiter", () => {
	const rendered = renderStore(state({ entries: ["a", "b"], used: 9, percent: 12 }));
	assert.ok(rendered.startsWith("═"));
	assert.ok(rendered.includes("MEMORY (your personal notes) [12% — 9/2,200 chars]"));
	assert.ok(rendered.includes(`a${ENTRY_SEPARATOR}b`));
});

test("project stores use their own labels", () => {
	const global = state({});
	const project = state({
		scope: "project",
		target: "memory",
		label: "PROJECT MEMORY (this project's notes)",
		entries: ["repo fact"],
		used: 9,
	});
	const block = renderMemoryBlock([global, project]);
	assert.ok(block.includes("PROJECT MEMORY (this project's notes)"));
	assert.ok(!block.includes("MEMORY (your personal notes)"));
});

test("the block skips empty stores", () => {
	const empty = state({});
	const full = state({ target: "user", label: "USER PROFILE", entries: ["x"], used: 1, limit: 1375 });
	assert.equal(renderMemoryBlock([empty, full]), renderStore(full));
	assert.equal(renderMemoryBlock([empty]), "");
});
