import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { findProjectRoot, projectMemoryDir } from "./paths.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-root-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

test("finds the nearest ancestor containing a .git directory", () => {
	const repo = join(root, "repo");
	const nested = join(repo, "packages", "app", "src");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(nested, { recursive: true });
	assert.equal(findProjectRoot(nested), repo);
});

test("treats a .git file (worktree) as the root marker", () => {
	const repo = join(root, "wt");
	const nested = join(repo, "sub");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n");
	assert.equal(findProjectRoot(nested), repo);
});

test("falls back to the start directory when no repository is found", () => {
	const plain = join(root, "plain", "nested");
	mkdirSync(plain, { recursive: true });
	assert.equal(findProjectRoot(plain), plain);
});

test("project memory dir lives under the project root", () => {
	const repo = join(root, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	const nested = join(repo, "sub");
	mkdirSync(nested, { recursive: true });
	assert.equal(projectMemoryDir(nested), join(repo, ".pi", "memories"));
});
