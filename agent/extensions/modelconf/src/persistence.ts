import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globToRegExp } from "./glob.js";

export type ModelId = `${string}/${string}`;

export function toModelId(m: { provider: string; id: string }): ModelId {
  return `${m.provider}/${m.id}` as ModelId;
}

function settingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function stripThinkingLevel(pattern: string): string {
  const idx = pattern.lastIndexOf(":");
  if (idx !== -1) {
    const suffix = pattern.slice(idx + 1);
    if (VALID_THINKING.has(suffix)) return pattern.slice(0, idx);
  }
  return pattern;
}

function matchesPattern(modelRef: string, pattern: string): boolean {
  const pat = stripThinkingLevel(pattern);
  const lowerRef = modelRef.toLowerCase();
  const lowerPat = pat.toLowerCase();
  const bareId = modelRef.split("/").slice(1).join("/")?.toLowerCase() ?? lowerRef;
  const hasGlob = /[*?\[\]]/.test(pat);
  if (hasGlob) {
    const rx = globToRegExp(pat);
    if (rx.test(modelRef)) return true;
    if (rx.test(bareId)) return true;
    return false;
  } else {
    return lowerRef === lowerPat || bareId === lowerPat;
  }
}

function modelMatchesAnyPattern(modelRef: string, patterns: string[]): boolean {
  for (const p of patterns) if (matchesPattern(modelRef, p)) return true;
  return false;
}

// ---------- hiddenModels (denylist) — hides from full picker list ----------
export async function loadHiddenModels(): Promise<string[] | undefined> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const j = JSON.parse(raw) as { hiddenModels?: string[] };
    return j.hiddenModels;
  } catch { return undefined; }
}

// Backward compat alias — old code used enabledModels
export async function loadEnabledModels(): Promise<string[] | undefined> {
  return loadHiddenModels();
}

export async function saveHiddenModels(ids: string[] | undefined): Promise<void> {
  const p = settingsPath();
  let j: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(p, "utf8");
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch (e: any) {
    if ((e as any)?.code !== "ENOENT") {
      j = {};
      try { const raw = await fs.readFile(p, "utf8"); JSON.parse(raw); } catch {}
    }
  }
  if (ids === undefined || ids.length === 0) delete (j as any).hiddenModels;
  else (j as any).hiddenModels = ids;
  // Do not touch enabledModels — this extension no longer manages it.
  await fs.writeFile(p, JSON.stringify(j, null, 2) + "\n", "utf8");
}

export async function saveEnabledModels(ids: string[] | undefined): Promise<void> {
  return saveHiddenModels(ids);
}

export function isHidden(modelId: ModelId, hidden: string[] | undefined): boolean {
  if (!hidden || hidden.length === 0) return false;
  return modelMatchesAnyPattern(modelId, hidden) || modelMatchesAnyPattern(modelId.split("/").slice(1).join("/") as ModelId, hidden);
}

export function isVisible(modelId: ModelId, hidden: string[] | undefined, _allIds: ModelId[]): boolean {
  if (!hidden || hidden.length === 0) return true;
  return !isHidden(modelId, hidden);
}

export function getVisibilityMap(all: Array<{provider:string;id:string}>, hidden: string[]|undefined): Map<ModelId, boolean> {
  const map = new Map<ModelId, boolean>();
  const allIds = all.map(toModelId);
  for (const m of all) map.set(toModelId(m), isVisible(toModelId(m), hidden, allIds));
  return map;
}

// Hide/show operates on the FULL model list (allIds = full catalogue).
// hidden is a denylist: adding = hide, removing = show.
export function toggleHidden(modelId: ModelId, hidden: string[] | undefined, _allIds: ModelId[]): string[] | undefined {
  if (!hidden || hidden.length === 0) {
    return [modelId];
  }
  // Exact match toggle. If hidden contains globs that already hide this model, we still toggle exact id.
  // If model is hidden via pattern, toggling will add exact? Instead remove matching patterns? Simplify: exact toggle.
  const hasExact = hidden.includes(modelId);
  // Also consider pattern hiding: if model matches a pattern, showing should remove? But we can't know which pattern.
  // For now, if hidden via pattern and not exact, toggling to "show" should add an exception? Simpler: if currently hidden (pattern or exact), remove exact and also remove any pattern that matches it? That's ambiguous.
  // We treat visibility via pattern: if isHidden true but not exact, toggling "show" means we need to keep patterns but add exception — not supported.
  // Simplest: if currently hidden, remove exact if present, otherwise add exact and keep patterns — model stays hidden. To actually show, we'd need to remove matching patterns.
  // So if hidden via pattern, show action should remove matching patterns.
  const currentlyHidden = isHidden(modelId, hidden);
  if (currentlyHidden) {
    // Remove exact if present
    let next = hidden.filter(id => id !== modelId);
    // Also remove any glob pattern that matches this model (so it becomes visible)
    next = next.filter(p => !matchesPattern(modelId, p));
    if (next.length === 0) return undefined;
    return next;
  } else {
    // Currently visible — hide by adding exact id
    if (hasExact) return hidden.filter(id => id !== modelId);
    return [...hidden, modelId];
  }
}

// Aliases for old names
export function toggleInEnabled(modelId: ModelId, hidden: string[] | undefined, allIds: ModelId[]): string[] | undefined {
  return toggleHidden(modelId, hidden, allIds);
}

export function applyBulk(hidden: string[]|undefined, allIds: ModelId[], matching: ModelId[], action: "include"|"exclude"): string[]|undefined {
  // For denylist: "exclude" = hide (add to hidden), "include" = show (remove from hidden)
  if (action === "exclude") {
    const base = hidden === undefined ? [] : [...hidden];
    const set = new Set(base);
    for (const id of matching) set.add(id);
    const arr = [...set].sort();
    if (arr.length === 0) return undefined;
    return arr;
  } else {
    // include = show
    if (!hidden || hidden.length === 0) return undefined;
    // Remove exact ids and any pattern that matches them? For now remove exact and patterns that match
    let next = [...hidden];
    for (const id of matching) {
      next = next.filter(p => p !== id && !matchesPattern(id, p));
      // If p is exact id matching model, remove; if p is glob that would match id, also remove? But glob may hide other models — removing it would unhide others unintentionally.
      // Better only remove exact matches for bulk include, keep globs.
      // Rebuild: only remove exact ids
    }
    // Recompute strictly exact removal to avoid over-removing globs
    const exactSet = new Set(matching as string[]);
    next = (hidden as string[]).filter(p => {
      // If p is exact id in matching, remove
      if (exactSet.has(p)) return false;
      return true;
    });
    if (next.length === 0) return undefined;
    return next;
  }
}
