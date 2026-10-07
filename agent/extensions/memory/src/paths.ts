import * as fs from "node:fs";
import * as path from "node:path";

/** Project config directory name, matching pi's `<project>/.pi`. */
export const PROJECT_CONFIG_DIR = ".pi";

/**
 * Walk up from `startDir` to the nearest ancestor containing a `.git` entry
 * (a directory, or a file for worktrees and submodules) and return it as the
 * project root. Falls back to `startDir` when no repository is found, so memory
 * still works outside version control.
 */
export function findProjectRoot(startDir: string): string {
	const start = path.resolve(startDir);
	let dir = start;
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** Project memory directory: `<projectRoot>/.pi/memories`. */
export function projectMemoryDir(startDir: string): string {
	return path.join(findProjectRoot(startDir), PROJECT_CONFIG_DIR, "memories");
}
