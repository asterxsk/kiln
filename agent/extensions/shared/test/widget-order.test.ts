/**
 * widget-order.test.ts — fixed stacking order for the above-editor widgets.
 *
 * Each extension loads in an isolated jiti module instance, so this test
 * imports a DIFFERENT vendored copy of the helper per widget key (mirroring
 * production) to prove the copies coordinate through the shared globalThis
 * registry. The fake ui replicates pi core's Map insertion-order semantics:
 * every setWidget moves the key to the end (closest to the input).
 *
 * Run: node --test agent/extensions/shared/widget-order.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

// One copy per widget — exactly how the three extensions consume them.
import {
	hideOrderedWidget as hideTodos,
	setOrderedWidget as setTodos,
	WIDGET_ORDER,
} from "../../todo/widget-order.ts";
import {
	hideOrderedWidget as hideTerms,
	setOrderedWidget as setTerms,
} from "../../background-terminals/src/widget-order.ts";
import {
	hideOrderedWidget as hideSubs,
	setOrderedWidget as setSubs,
} from "../../subagents/src/widget-order.ts";

const TODOS = "rpiv-todos";
const TERMS = "background-terminals";
const SUBS = "subagents";

/** Canonical order: todos furthest from the input, subagents closest. */
const CANONICAL = [TODOS, TERMS, SUBS];

interface FakeUI {
	setWidget(key: string, content: unknown, options?: unknown): void;
}

function createFakeUI() {
	// Map insertion order == pi core's widgetContainerAbove render order.
	const map = new Map<string, unknown>();
	const calls: Array<{ key: string; cleared: boolean }> = [];
	const ui: FakeUI = {
		setWidget(key: string, content: unknown) {
			calls.push({ key, cleared: content === undefined });
			if (content === undefined) map.delete(key);
			else map.set(key, content);
		},
	};
	return {
		ui,
		calls,
		order: () => [...map.keys()],
		contentOf: (key: string) => map.get(key),
	};
}

const fac = (marker: string) => (_tui: unknown, _theme: unknown) => ({
	render: () => [marker],
	invalidate: () => {},
});

function resetRegistry(ui: FakeUI) {
	// Hide-all returns every test to a clean slate (registry + fake pi map).
	hideTodos(ui as never, TODOS as never);
	hideTerms(ui as never, TERMS as never);
	hideSubs(ui as never, SUBS as never);
}

afterEach(() => {
	// Guard against registry leakage if a test fails mid-sequence.
	resetRegistry(createFakeUI().ui);
});

test("canonical order is exported and matches the required stacking", () => {
	assert.deepEqual([...WIDGET_ORDER], CANONICAL);
});

test("pins canonical order regardless of registration sequence", () => {
	const f = createFakeUI();
	resetRegistry(f.ui);
	// Worst case: reverse registration order.
	setSubs(f.ui as never, SUBS as never, fac("sub") as never);
	setTerms(f.ui as never, TERMS as never, fac("bg") as never);
	setTodos(f.ui as never, TODOS as never, fac("todo") as never);
	assert.deepEqual(f.order(), CANONICAL);
});

test("top widget registering last still lands on top (the reported bug)", () => {
	const f = createFakeUI();
	resetRegistry(f.ui);
	// Terminals + subagents already visible when the todo overlay registers
	// at agent_start. Naive setWidget would append todos at the bottom.
	setTerms(f.ui as never, TERMS as never, fac("bg") as never);
	setSubs(f.ui as never, SUBS as never, fac("sub") as never);
	setTodos(f.ui as never, TODOS as never, fac("todo") as never);
	assert.deepEqual(f.order(), CANONICAL);
});

test("refreshing the middle widget keeps order and stores latest content", () => {
	const f = createFakeUI();
	resetRegistry(f.ui);
	setTodos(f.ui as never, TODOS as never, fac("todo") as never);
	setTerms(f.ui as never, TERMS as never, fac("bg-1") as never);
	setSubs(f.ui as never, SUBS as never, fac("sub") as never);
	// Background count changes 1 -> 2: re-set must not sink it to the bottom.
	setTerms(f.ui as never, TERMS as never, fac("bg-2") as never);
	assert.deepEqual(f.order(), CANONICAL);
	const current = f.contentOf(TERMS) as (_t: unknown, _th: unknown) => { render: () => string[] };
	assert.deepEqual(current({}, {}).render(), ["bg-2"]);
});

test("hiding the middle widget preserves survivors; re-show restores slot", () => {
	const f = createFakeUI();
	resetRegistry(f.ui);
	setTodos(f.ui as never, TODOS as never, fac("todo") as never);
	setTerms(f.ui as never, TERMS as never, fac("bg") as never);
	setSubs(f.ui as never, SUBS as never, fac("sub") as never);
	hideTerms(f.ui as never, TERMS as never);
	assert.deepEqual(f.order(), [TODOS, SUBS]);
	setTerms(f.ui as never, TERMS as never, fac("bg") as never);
	assert.deepEqual(f.order(), CANONICAL);
});

test("setOrderedWidget with undefined content hides", () => {
	const f = createFakeUI();
	resetRegistry(f.ui);
	setTodos(f.ui as never, TODOS as never, fac("todo") as never);
	assert.deepEqual(f.order(), [TODOS]);
	setTodos(f.ui as never, TODOS as never, undefined);
	assert.deepEqual(f.order(), []);
});

test("hiding an untracked key still clears pi directly", () => {
	const f = createFakeUI();
	resetRegistry(f.ui);
	hideSubs(f.ui as never, SUBS as never);
	assert.ok(
		f.calls.some((c) => c.key === SUBS && c.cleared),
		"expected a direct clear for the untracked key",
	);
	assert.deepEqual(f.order(), []);
});

test("undefined ui is a safe no-op", () => {
	assert.doesNotThrow(() => {
		setTodos(undefined as never, TODOS as never, fac("todo") as never);
		hideTodos(undefined as never, TODOS as never);
	});
});

test("vendored helper copies stay byte-identical", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const files = [
		"../todo/widget-order.ts",
		"../background-terminals/src/widget-order.ts",
		"../subagents/src/widget-order.ts",
	].map((rel) => fs.readFileSync(path.resolve(here, rel), "utf8"));
	assert.equal(files[1], files[0], "background-terminals copy diverged from todo copy");
	assert.equal(files[2], files[0], "subagents copy diverged from todo copy");
});
