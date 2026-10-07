import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ENTRY_SEPARATOR, MemoryError, MemoryStore, type MemoryDirs } from "./store.ts";

let root: string;
let dirs: MemoryDirs;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-memory-"));
	dirs = { global: join(root, "global"), project: join(root, "project") };
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

test("adds entries, persists them with the § delimiter, and reports usage", () => {
	const store = new MemoryStore(dirs);
	const state = store.add("global", "memory", "Project uses pnpm");
	assert.equal(state.entries.length, 1);
	assert.equal(state.used, "Project uses pnpm".length);
	assert.deepEqual(store.load("global", "memory"), ["Project uses pnpm"]);

	store.add("global", "memory", "Runs on Windows");
	assert.ok(readFileSync(join(dirs.global, "MEMORY.md"), "utf8").includes(ENTRY_SEPARATOR));
	assert.deepEqual(store.load("global", "memory"), ["Project uses pnpm", "Runs on Windows"]);
});

test("rejects a write that would overflow the store's limit", () => {
	const store = new MemoryStore(dirs);
	assert.throws(() => store.add("global", "memory", "x".repeat(2201)), MemoryError);
	assert.throws(() => store.add("project", "user", "x".repeat(1376)), MemoryError);
	assert.deepEqual(store.load("global", "memory"), []);
});

test("global and project scopes are independent files", () => {
	const store = new MemoryStore(dirs);
	store.add("global", "memory", "shared fact");
	store.add("project", "memory", "repo fact");
	assert.deepEqual(store.load("global", "memory"), ["shared fact"]);
	assert.deepEqual(store.load("project", "memory"), ["repo fact"]);
});

test("replace overwrites the whole matched entry by unique substring", () => {
	const store = new MemoryStore(dirs);
	store.add("project", "memory", "Editor: vim");
	store.add("project", "memory", "Shell: zsh");
	const state = store.replace("project", "memory", "vim", "Editor: neovim");
	assert.deepEqual(state.entries, ["Editor: neovim", "Shell: zsh"]);
});

test("replace and remove fail on ambiguous or missing substrings", () => {
	const store = new MemoryStore(dirs);
	store.add("global", "memory", "Uses dark mode");
	store.add("global", "memory", "Uses dark theme");
	assert.throws(() => store.replace("global", "memory", "dark", "x"), /matches 2 entries/);
	assert.throws(() => store.remove("global", "memory", "nope"), /No entry/);
});

test("remove deletes only the matched entry", () => {
	const store = new MemoryStore(dirs);
	store.add("global", "user", "Prefers terse answers");
	store.add("global", "user", "Timezone: UTC");
	const state = store.remove("global", "user", "terse");
	assert.deepEqual(state.entries, ["Timezone: UTC"]);
});

test("loadAll returns all four stores in global-then-project order", () => {
	const store = new MemoryStore(dirs);
	assert.deepEqual(
		store.loadAll().map((state) => `${state.scope}:${state.target}`),
		["global:memory", "global:user", "project:memory", "project:user"],
	);
});
