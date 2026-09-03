import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

export type SkillPackages = Record<string, string[]>;

export interface SkillState {
  /** Names of disabled skills. undefined/empty = all enabled. */
  disabled: string[] | undefined;
  /** Package name -> member skill names. Never undefined (may be empty). */
  packages: SkillPackages;
}

function settingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function parseState(json: unknown): SkillState {
  const j = (json ?? {}) as Record<string, unknown>;
  const rawDisabled = Array.isArray(j.disabledSkills)
    ? (j.disabledSkills as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  const rawPkgs = (j.skillPackages ?? {}) as Record<string, unknown>;
  const packages: SkillPackages = {};
  if (rawPkgs && typeof rawPkgs === "object") {
    for (const [k, v] of Object.entries(rawPkgs)) {
      if (typeof k !== "string" || !Array.isArray(v)) continue;
      packages[k] = normalizeMembers(v.filter((x): x is string => typeof x === "string"));
    }
  }
  return {
    disabled: rawDisabled && rawDisabled.length > 0 ? [...new Set(rawDisabled)].sort() : undefined,
    packages,
  };
}

export async function loadSkillState(): Promise<SkillState> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return parseState(JSON.parse(raw));
  } catch {
    return { disabled: undefined, packages: {} };
  }
}

export function loadSkillStateSync(): SkillState {
  try {
    const raw = fsSync.readFileSync(settingsPath(), "utf8");
    return parseState(JSON.parse(raw));
  } catch {
    return { disabled: undefined, packages: {} };
  }
}

/**
 * Persist state. `knownSkills` (when provided) is used to drop stale names
 * from the disabled list and from package memberships. Packages are kept
 * even when empty so freshly created groups survive until filled.
 */
export async function saveSkillState(
  disabled: string[] | undefined,
  packages: SkillPackages,
  knownSkills?: string[],
): Promise<void> {
  const p = settingsPath();
  let j: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(p, "utf8");
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      try {
        const raw = await fs.readFile(p, "utf8");
        JSON.parse(raw);
      } catch {}
    }
    j = {};
  }
  const known = knownSkills ? new Set(knownSkills) : null;
  const cleanDisabled = (disabled ?? []).filter((n) => (known ? known.has(n) : true));
  if (cleanDisabled.length === 0) delete j.disabledSkills;
  else j.disabledSkills = [...new Set(cleanDisabled)].sort();

  const cleanPkgs: SkillPackages = {};
  for (const name of Object.keys(packages).sort()) {
    const members = normalizeMembers(packages[name] ?? []).filter((n) =>
      known ? known.has(n) : true,
    );
    cleanPkgs[name] = members;
  }
  if (Object.keys(cleanPkgs).length === 0) delete j.skillPackages;
  else j.skillPackages = cleanPkgs;

  await fs.writeFile(p, JSON.stringify(j, null, 2) + "\n", "utf8");
}

// ---------- pure helpers (unit-tested) ----------

export function normalizeMembers(members: string[]): string[] {
  return [...new Set(members)].sort();
}

export function isDisabled(name: string, disabled: string[] | undefined): boolean {
  if (!disabled || disabled.length === 0) return false;
  return disabled.includes(name);
}

/** Toggle one skill. Returns undefined when nothing ends up disabled. */
export function toggleSkill(name: string, disabled: string[] | undefined): string[] | undefined {
  const set = new Set(disabled ?? []);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  if (set.size === 0) return undefined;
  return [...set].sort();
}

/**
 * Toggle a whole package: if every (known) member is disabled, enable them
 * all; otherwise disable all of them. Members unknown to the caller are
 * passed through untouched. Returns undefined when nothing ends up disabled.
 */
export function togglePackage(
  members: string[],
  disabled: string[] | undefined,
): string[] | undefined {
  if (members.length === 0) return disabled && disabled.length > 0 ? [...disabled] : undefined;
  const set = new Set(disabled ?? []);
  const allDisabled = members.every((m) => set.has(m));
  if (allDisabled) {
    for (const m of members) set.delete(m);
  } else {
    for (const m of members) set.add(m);
  }
  if (set.size === 0) return undefined;
  return [...set].sort();
}

export function toggleMembership(members: string[], name: string): string[] {
  const set = new Set(members);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  return [...set].sort();
}

/** Normalized deep-equal for dirty checking. */
export function statesEqual(a: SkillState, b: SkillState): boolean {
  const da = a.disabled ?? [];
  const db = b.disabled ?? [];
  if (da.length !== db.length) return false;
  const sa = [...da].sort();
  const sb = [...db].sort();
  if (JSON.stringify(sa) !== JSON.stringify(sb)) return false;
  const ka = Object.keys(a.packages).sort();
  const kb = Object.keys(b.packages).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
  for (const k of ka) {
    const ma = normalizeMembers(a.packages[k] ?? []);
    const mb = normalizeMembers(b.packages[k] ?? []);
    if (JSON.stringify(ma) !== JSON.stringify(mb)) return false;
  }
  return true;
}

export function cloneState(s: SkillState): SkillState {
  const packages: SkillPackages = {};
  for (const [k, v] of Object.entries(s.packages)) packages[k] = [...v];
  return { disabled: s.disabled === undefined ? undefined : [...s.disabled], packages };
}
