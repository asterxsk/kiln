import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Resolve what `d` on a skill should remove from disk:
 * - a `SKILL.md` file means the skill owns its parent directory -> remove the dir
 * - a lone `.md` file (root-level skill) -> remove just the file
 * Returns null when the location is missing or not absolute (never delete
 * relative to an assumed cwd).
 */
export function resolveSkillDeleteTarget(filePath: string): string | null {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  const normalized = path.normalize(filePath);
  if (path.basename(normalized) === "SKILL.md") return path.dirname(normalized);
  return normalized;
}

/**
 * Delete a skill from disk. Throws on anything unexpected; callers surface
 * the message. Refuses filesystem root, home, and items directly in home.
 * Returns the removed path.
 */
export async function deleteSkillFiles(filePath: string): Promise<string> {
  const target = resolveSkillDeleteTarget(filePath);
  if (!target) throw new Error("unknown or non-absolute skill location");
  const root = path.parse(target).root;
  if (target === root) throw new Error(`refusing to delete filesystem root (${target})`);
  const home = path.normalize(os.homedir());
  if (target === home) throw new Error("refusing to delete home directory");
  if (path.dirname(target) === home) {
    throw new Error("refusing to delete items directly in home directory");
  }
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(target);
  } catch {
    throw new Error(`not found: ${target}`);
  }
  const wantsDir = path.basename(path.normalize(filePath)) === "SKILL.md";
  if (wantsDir && !st.isDirectory()) throw new Error(`expected a directory: ${target}`);
  if (!wantsDir && !st.isFile()) throw new Error(`expected a file: ${target}`);
  await fs.rm(target, { recursive: true });
  return target;
}
