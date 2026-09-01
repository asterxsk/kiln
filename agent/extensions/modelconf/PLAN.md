# modelconf Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `modelconf` pi extension in its own folder (`~/.pi/agent/extensions/modelconf/`) that provides a TUI for browsing models per-provider, fuzzy-filtering, toggling hidden/visible with persisting via `enabledModels`, and bulk glob include/exclude.

**Architecture:** Single extension folder `modelconf/` with `index.ts` entry registering `/modelconf` command. A state helper reads/writes `settings.json` (`enabledModels`) and diffs against `ctx.modelRegistry.getAll()` vs `getAvailable()`. A full-screen custom TUI component (`ModelConfView`) renders provider-grouped list; sub-overlays handle `/` fuzzy search and `x` glob menu. Fuzzy matching is a local `fuzzyMatch()` (subsequence + scoring) to avoid extra deps. Glob uses `minimatch` or simple `*`->RegExp conversion. Save calls `settingsManager.setEnabledModels()` if available else fs write + `ctx.reload()`.

**Tech Stack:** TypeScript (strict), `@earendil-works/pi-coding-agent` ExtensionAPI, `@earendil-works/pi-tui` (Container, Input, theme), `typebox` for tool params (not needed), Node `fs/promises`, `os`, `path`. No new runtime deps except optional `minimatch` (prefer zero-dep includes).

## Global Constraints

- Extension must be in its own folder named `modelconf` — discovery via `~/.pi/agent/extensions/` and `settings.json` `extensions: ["extensions/"]`.
- Must support per-provider grouping and indicate visible vs hidden per `enabledModels`.
- Fuzzy search triggered by `/`, hide/show via `Space`, save via `Enter`, bulk glob menu via `x`, close via `Esc`/`q`.
- Persistence must survive reload and affect `pi --list-models` / model picker (i.e., write to settings).
- Follow existing extension patterns in `~/.pi/agent/extensions/ask-user/index.ts` (default export function, `ctx.ui.custom` with `(tui, theme, keybindings, done)`).
- Keep extension import-light; do not add `effect` unless justified.

---

## File Structure

```
~/.pi/agent/extensions/modelconf/
├── package.json                 # type: module, private, scripts: check/build, deps
├── tsconfig.json                # extends strict, outDir dist, rootDir .
├── index.ts                     # Extension entry: registers /modelconf, owns state + launch
├── src/
│   ├── persistence.ts           # loadEnabledModels(), saveEnabledModels(), isVisible(), diff
│   ├── fuzzy.ts                 # fuzzyScore, fuzzyFilter, highlight helpers
│   ├── glob.ts                  # globToRegExp / matchesGlob, bulk apply helpers
│   └── ui/
│       ├── ModelConfView.ts     # Main TUI Component: grouped list, key handling, renders
│       ├── SearchOverlay.ts     # Optional: / search input overlay component
│       └── GlobMenu.ts          # Optional: x bulk dialog (input + include/exclude choice)
└── README.md                    # usage / keybindings
```

Modify (no deletion of unrelated files):
- `~/.pi/agent/settings.json` — read/write only via extension at runtime (no committed change), but plan verifies write path.

Existing patterns to reuse:
- `examples/extensions/tools.ts` — `SettingsList` toggle pattern (reference for persist + `pi.appendEntry` branch restore) — read before Task 5.
- `examples/extensions/preset.ts` — `ctx.ui.custom` + `Container` + header rendering.
- `~/.pi/agent/extensions/ask-user/index.ts` — `ctx.ui.custom` returning `{render, handleInput, invalidate}` object, `tui.requestRender()` after state change.

---

### Task 1: Scaffold `modelconf` extension folder

**Files:**
- Create: `./package.json`
- Create: `./tsconfig.json`
- Create: `./index.ts` (skeleton)
- Create: `./README.md`
- Create: `./src/persistence.ts` (empty stub)
- Create: `./src/fuzzy.ts` (empty stub)
- Create: `./src/glob.ts` (empty stub)
- Create: `./src/ui/ModelConfView.ts` (empty stub)

**Interfaces:**
- Consumes: none
- Produces: extension is discoverable via `/reload`, registers `/modelconf` placeholder that opens empty custom UI (used by all later tasks).

- [ ] **Step 1: Create folder structure**

```bash
mkdir -p ~/.pi/agent/extensions/modelconf/src/ui
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "modelconf",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "description": "Per-provider model visibility manager with fuzzy search and bulk glob",
  "scripts": { "check": "tsc --noEmit" },
  "dependencies": {},
  "devDependencies": { "typescript": "^5.6.0" },
  "allowScripts": {}
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["index.ts", "src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 4: Write skeleton `index.ts` that registers `/modelconf` and shows placeholder UI**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function modelconf(pi: ExtensionAPI) {
  pi.registerCommand("modelconf", {
    description: "Manage model visibility per provider (fuzzy search: /, toggle: space, bulk: x, save: enter)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/modelconf requires TUI mode", "error");
        return;
      }
      await ctx.ui.custom((tui, theme, _kb, done) => {
        let closed = false;
        return {
          render(width: number) {
            const title = theme.fg("accent", theme.bold("modelconf — scaffold"));
            const hint = theme.fg("dim", "Press Esc to close · upcoming: / fuzzy, space toggle, x glob, enter save");
            return [title, hint, ""];
          },
          invalidate() {},
          handleInput(data: string) {
            if (data === "\x1b" || data === "q") { if (!closed) { closed = true; done(undefined); } }
            tui.requestRender();
          },
        };
      });
    },
  });
}
```

- [ ] **Step 5: Verify discovery**

Run: `pi --help` (check no load error) then inside pi run `/reload` — expect no error and `/modelconf` appears in command list. Test: `pi -e ~/.pi/agent/extensions/modelconf --help` alternative smoke.

- [ ] **Step 6: Commit**

```
feat(modelconf): scaffold extension folder with /modelconf placeholder
```

---

### Task 2: Persistence helper — map `enabledModels` to visible/hidden

**Files:**
- Create: `./src/persistence.ts`
- Modify: `./index.ts` (import helper, log counts — no UI yet)
- Test: `./src/persistence.test.ts` (manual node test script, since plan forbids one-off bash tests — write a dedicated test file)

**Interfaces:**
- Consumes: `ctx.modelRegistry.getAll(): Model[]`, `ctx.modelRegistry.getAvailable(): Model[]`, `settings.json` on disk
- Produces:
  ```typescript
  // persistence.ts
  export type ModelId = `${string}/${string}`; // provider/modelId
  export function toModelId(m: { provider: string; id: string }): ModelId;
  export function loadEnabledModels(): Promise<string[] | undefined>;
  export function saveEnabledModels(ids: string[] | undefined): Promise<void>;
  export function isVisible(modelId: ModelId, enabled: string[] | undefined, allIds: ModelId[]): boolean;
  export function getVisibilityMap(all: Array<{provider:string;id:string}>, enabled: string[]|undefined): Map<ModelId, boolean>;
  export function toggleInEnabled(modelId: ModelId, enabled: string[] | undefined, allIds: ModelId[]): string[] | undefined;
  // helpers for glob bulk — consumed by Task 6/8
  export function applyBulk(enabled: string[]|undefined, allIds: ModelId[], matching: ModelId[], action: "include"|"exclude"): string[]|undefined;
  ```

- [ ] **Step 1: Write failing test for visibility semantics**

```typescript
// src/persistence.test.ts
import { isVisible, toModelId } from "./persistence.js";
import assert from "node:assert";
const all = ["opencode/a","opencode/b","9router/c"] as const;
// enabled undefined => all visible
assert.equal(isVisible("opencode/a", undefined, [...all] as any), true);
// empty array => none visible (pi convention: empty means none? verify — if pi treats empty as none, mirror that)
assert.equal(isVisible("opencode/a", [], [...all] as any), false);
assert.equal(isVisible("opencode/a", ["opencode/a"], [...all] as any), true);
assert.equal(isVisible("opencode/b", ["opencode/a"], [...all] as any), false);
console.log("persistence test pass");
```

- [ ] **Step 2: Run test to verify it fails** (module not implemented)

Run: `npx tsc --noEmit` then `node --loader tsx src/persistence.test.ts` — expected FAIL `cannot find module`.

- [ ] **Step 3: Implement `src/persistence.ts` minimal**

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ModelId = `${string}/${string}`;

export function toModelId(m: { provider: string; id: string }): ModelId {
  return `${m.provider}/${m.id}` as ModelId;
}

function settingsPath(): string {
  // Global settings — matches pi default. Project-local .pi/settings.json intentionally not handled in v1; document it.
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export async function loadEnabledModels(): Promise<string[] | undefined> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const j = JSON.parse(raw) as { enabledModels?: string[] };
    return j.enabledModels;
  } catch { return undefined; }
}

export async function saveEnabledModels(ids: string[] | undefined): Promise<void> {
  const p = settingsPath();
  const raw = await fs.readFile(p, "utf8");
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (ids === undefined) delete j.enabledModels;
  else j.enabledModels = ids;
  await fs.writeFile(p, JSON.stringify(j, null, 2) + "\n", "utf8");
}

export function isVisible(modelId: ModelId, enabled: string[] | undefined, _allIds: ModelId[]): boolean {
  if (enabled === undefined) return true; // no filter => all visible
  return enabled.includes(modelId);
}

export function getVisibilityMap(all: Array<{provider:string;id:string}>, enabled: string[]|undefined): Map<ModelId, boolean> {
  const map = new Map<ModelId, boolean>();
  const allIds = all.map(toModelId);
  for (const m of all) map.set(toModelId(m), isVisible(toModelId(m), enabled, allIds));
  return map;
}

export function toggleInEnabled(modelId: ModelId, enabled: string[] | undefined, allIds: ModelId[]): string[] | undefined {
  if (enabled === undefined) {
    // First toggle while all visible => materialize as "all except one hidden"
    return allIds.filter(id => id !== modelId);
  }
  if (enabled.includes(modelId)) return enabled.filter(id => id !== modelId);
  return [...enabled, modelId];
}

export function applyBulk(enabled: string[]|undefined, allIds: ModelId[], matching: ModelId[], action: "include"|"exclude"): string[]|undefined {
  if (action === "include") {
    const base = enabled === undefined ? [...allIds] : [...enabled];
    const set = new Set(base);
    for (const id of matching) set.add(id);
    const arr = [...set];
    // if all visible, store undefined to keep settings clean
    if (arr.length === allIds.length) return undefined;
    return arr;
  } else {
    if (enabled === undefined) return allIds.filter(id => !matching.includes(id));
    return enabled.filter(id => !matching.includes(id));
  }
}
```

Note: Verify against real pi semantics for `enabledModels: []` vs `undefined` by reading `SettingsManager.getEnabledModels()` impl in `dist/modes/interactive/interactive-mode.js:4184` — if empty means "filter to none", the above is correct; if empty is treated as "no filter", adjust `isVisible`.

- [ ] **Step 4: Run test again — expect PASS**

Run: `npx tsc --noEmit` → PASS, then `node --loader tsx src/persistence.test.ts`.

- [ ] **Step 5: Wire a debug log into `index.ts` handler**

In `/modelconf` handler, before `ctx.ui.custom`, do:
```typescript
const all = ctx.modelRegistry.getAll().map(m => ({ provider: (m as any).provider, id: m.id }));
const avail = ctx.modelRegistry.getAvailable().map(m => `${(m as any).provider}/${m.id}`);
console.log(`[modelconf] all=${all.length} avail=${avail.length}`);
```
Verify in pi logs.

- [ ] **Step 6: Commit**

```
feat(modelconf): add persistence helper for enabledModels mapping
```

---

### Task 3: Fuzzy search utility (`/`)

**Files:**
- Create: `./src/fuzzy.ts`
- Test: `./src/fuzzy.test.ts`

**Interfaces:**
- Consumes: array of `ModelId` strings
- Produces:
  ```typescript
  export function fuzzyScore(query: string, target: string): number | null; // null = no match
  export function fuzzyFilter<T>(query: string, items: T[], key: (t:T)=>string): T[]; // sorted by score
  export function highlightMatch(target: string, query: string, theme: any): string; // optional
  ```

- [ ] **Step 1: Write failing test**

```typescript
import { fuzzyScore, fuzzyFilter } from "./fuzzy.js";
import assert from "node:assert";
assert.ok(fuzzyScore("gpl", "gpt-5.6-luna") === null);
assert.ok(typeof fuzzyScore("lun", "gpt-5.6-luna") === "number");
const out = fuzzyFilter("lun", [{id:"gpt-5.6-luna"},{id:"minimax-m3"}], x=>x.id);
assert.equal(out[0].id, "gpt-5.6-luna");
console.log("fuzzy pass");
```

- [ ] **Step 2: Run to confirm fail**
- [ ] **Step 3: Implement subsequence scorer (no deps)**

```typescript
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, ti = 0, score = 0, last = -2;
  for (; qi < q.length && ti < t.length; ti++) {
    if (q[qi] === t[ti]) {
      // bonus for contiguous + start-of-word
      score += (ti === last + 1 ? 2 : 1);
      if (ti === 0 || t[ti-1] === "/" || t[ti-1] === "-" || t[ti-1] === "_") score += 2;
      last = ti; qi++;
    }
  }
  if (qi !== q.length) return null;
  // penalize longer targets slightly
  score -= Math.floor(t.length / 20);
  return score;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t:T)=>string): T[] {
  if (!query.trim()) return items;
  const scored = items.map(i => ({ i, s: fuzzyScore(query, key(i)) }))
    .filter(x => x.s !== null) as Array<{i:T; s:number}>;
  scored.sort((a,b)=> b.s - a.s);
  return scored.map(x=>x.i);
}
```

- [ ] **Step 4: Run test pass + check `npx tsc --noEmit`**

- [ ] **Step 5: Commit**

```
feat(modelconf): add fuzzyScore / fuzzyFilter utility
```

---

### Task 4: Glob helper (`x` bulk)

**Files:**
- Create: `./src/glob.ts`
- Test: `./src/glob.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function matchesGlob(input: string, pattern: string): boolean;
  export function filterByGlob<T>(pattern: string, items: T[], key:(t:T)=>string): T[];
  ```

- [ ] **Step 1: Test**

```typescript
import { matchesGlob } from "./glob.js";
import assert from "node:assert";
assert.equal(matchesGlob("gpt-5.6-luna", "*luna*"), true);
assert.equal(matchesGlob("gpt-5.6-luna", "gpt*"), true);
assert.equal(matchesGlob("minimax-m3", "*luna*"), false);
assert.equal(matchesGlob("a/b/c", "*"), true);
console.log("glob pass");
```

- [ ] **Step 2: Implement (zero-dep, * and ? plus case-insensitive includes fallback)**

```typescript
export function globToRegExp(pattern: string): RegExp {
  // Support keyword without * as implicit *keyword* (per spec: "glob a keyword")
  let p = pattern;
  if (!p.includes("*") && !p.includes("?")) p = `*${p}*`;
  const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
export function matchesGlob(input: string, pattern: string): boolean {
  return globToRegExp(pattern).test(input);
}
export function filterByGlob<T>(pattern: string, items: T[], key:(t:T)=>string): T[] {
  const rx = globToRegExp(pattern);
  return items.filter(i => rx.test(key(i)));
}
```

Document that `*` semantics covers the spec's "keyword" as substring.

- [ ] **Step 3: Verify pass + tsc**
- [ ] **Step 4: Commit**

```
feat(modelconf): add glob helper for bulk keyword matching
```

---

### Task 5: Main TUI view — per-provider grouping + navigation

**Files:**
- Create: `./src/ui/ModelConfView.ts`
- Modify: `./index.ts` (delegate to ModelConfView)
- Test: manual TUI test (`/modelconf` visual)

**Interfaces:**
- Consumes: `persistence` helpers, `fuzzy` helpers, `glob` helpers, `ExtensionContext` modelRegistry + `loadEnabledModels`
- Produces: class `ModelConfView implements Component` with contract:

```typescript
export interface ModelRow { id: string; provider: string; modelId: string; visible: boolean; }
export class ModelConfView implements Component {
  constructor(opts: {
    tui: TUI; theme: Theme; keybindings: KeybindingsManager;
    allModels: Array<{provider:string; id:string; name?:string}>;
    visibleSet: Set<string>;
    enabledRaw: string[]|undefined;
    onDone: (saved: boolean)=>void;
    onPersist: (nextEnabled: string[]|undefined)=>Promise<void>;
  });
  render(width:number): string[];
  handleInput(data:string): void;
  invalidate(): void;
}
```

Rendering rules:
- Group by `provider` sorted alphabetically; providers collapsible? v1: all expanded, header line per provider: `▸ provider (3/10 visible)` in accent color.
- Rows: ` [x] modelId — name` where `[x]` is `■`/`□` or `☑`/`☐` with `visible ? success : dim`. Use `theme.fg`.
- Cursor line highlighted with `theme.bg("selection")` or `theme.fg("accent")`.
- Footer legend: `/ search  space toggle  x glob  enter save  esc cancel  ↑↓ navigate`.
- Limit height to `tui` height minus chrome; handle scrolling window.

Key handling (for this task — aiming for navigation only, search/toggle/bulk deferred):
- `j`/`ArrowDown`, `k`/`ArrowUp` move cursor (also handle Kitty keys from `keybindings`? check `Keyboard`).
- `g`/`Home` top, `G`/`End` bottom.

- [ ] **Step 1: Read reference implementations**

Open `examples/extensions/tools.ts` and `examples/extensions/preset.ts` and `src/persistence.ts` to confirm model id shape: `(m as any).provider` fallback to `m.provider` or `"unknown"`.

- [ ] **Step 2: Write failing visual placeholder — launch ModelConfView from index.ts**

In `index.ts` handler, construct `allModels` via:
```typescript
const allModels = ctx.modelRegistry.getAll().map(m => ({
  provider: (m as any).provider ?? "unknown",
  id: m.id,
  name: (m as any).name ?? m.id,
}));
const enabledRaw = await loadEnabledModels();
const map = getVisibilityMap(allModels, enabledRaw);
```

Pass to `new ModelConfView({ ... })` and return its `{render, handleInput, invalidate}`.

- [ ] **Step 3: Implement ModelConfView — grouped list + scroll + selection**

Pseudocode for `render(width)`:
```typescript
render(width:number): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("modelconf")) + theme.fg("dim", `  ${this.rows.length} models  ${this.visibleCount} visible`));
  lines.push(theme.fg("dim", "─".repeat(width)));
  for (const provider of this.sortedProviders) {
    const group = this.rowsByProvider.get(provider)!;
    const visibleInGroup = group.filter(r=>r.visible).length;
    lines.push(theme.fg(provider === this.currentProvider ? "accent" : "muted",
      `${this.isProviderCollapsed(provider) ? "▸" : "▾"} ${provider}  ${visibleInGroup}/${group.length}`));
    if (this.isProviderCollapsed(provider)) continue;
    for (const row of group) {
      const isCursor = row === this.cursorRow();
      const mark = row.visible ? theme.fg("success", "◉") : theme.fg("dim", "○");
      const label = `${mark} ${row.modelId}`.padEnd(40) + theme.fg("dim", row.name ?? "");
      const line = isCursor ? theme.bg("selection", label) : label;
      lines.push(theme.fg(isCursor ? "accent" : undefined as any, `  ${line}`));
    }
  }
  lines.push("", theme.fg("dim", "/ search  space toggle  x bulk  enter save  esc cancel"));
  return lines.map(l => truncateToWidth(l, width));
}
```

Cursor math: flat index over `this.flatRows` (filtered view later expands to include search).

`handleInput` v1: only up/down/g/q/esc; other keys `done(false)` on esc.

Call `tui.requestRender()` after any state change.

- [ ] **Step 4: Test in pi**

Commands:
```bash
pi
/modelconf
```
Verify:
- Providers appear grouped.
- Counts correct vs `cat ~/.pi/agent/settings.json | grep enabledModels`.
- Arrow keys move highlight, no crash on long list (test with `oc` provider with many models).

- [ ] **Step 5: Handle `width` overflow — truncate row labels to `width-6`**

Use `truncateToWidth` from `@earendil-works/pi-tui`.

- [ ] **Step 6: Commit**

```
feat(modelconf): main TUI view with per-provider grouping and navigation
```

---

### Task 6: Toggle (`Space`) + Save (`Enter`)

**Files:**
- Modify: `./src/ui/ModelConfView.ts`
- Modify: `./src/persistence.ts` (if toggle semantics need fix)
- Modify: `./index.ts` (persist callback)

**Interfaces:**
- Consumes: `toggleInEnabled`, `saveEnabledModels`
- Produces: updated `enabledRaw` inside ModelConfView, flush on Enter.

Behavior:
- `Space` toggles current row's `visible`; updates internal `draftEnabled` (copy of loaded `enabledRaw` mutated via `toggleInEnabled`). Recomputes `visibleSet`. Does not yet write to disk.
- Dirty indicator: title shows `● unsaved` when `draftEnabled !== original`.
- `Enter` calls `onPersist(draftEnabled)` → `saveEnabledModels` → `ctx.ui.notify("Saved N visible", "success")` → optional `ctx.reload()` to refresh model picker. Then `done(true)`.
- `Esc` discards if dirty: prompt confirm via inline footer "Discard changes? (y/N)" — simplest: `Esc` when dirty shows confirmation overlay; second `Esc` discards, `y` discards.

- [ ] **Step 1: Write unit test for draft toggling**

```typescript
import { toggleInEnabled } from "./persistence.js";
let draft: string[]|undefined = undefined;
const all = ["a/x","a/y","b/z"] as any;
draft = toggleInEnabled("a/x", draft, all);
assert.deepEqual(draft, ["a/y","b/z"]); // all-except-x
draft = toggleInEnabled("a/x", draft, all);
assert.ok(draft!.includes("a/x"));
console.log("toggle draft pass");
```

- [ ] **Step 2: Implement Space handling in ModelConfView.handleInput**

```typescript
if (data === " ") {
  const row = this.cursorRow(); if (!row) return;
  const modelId = `${row.provider}/${row.modelId}` as ModelId;
  this.draftEnabled = toggleInEnabled(modelId, this.draftEnabled, this.allIds);
  this.rebuildVisibility();
  tui.requestRender();
  return;
}
if (data === "\r" || data === "\n") { // Enter
  await this.opts.onPersist(this.draftEnabled);
  this.opts.onDone(true);
  return;
}
```

- [ ] **Step 3: Implement dirty check + footer hint**

```typescript
private isDirty(): boolean {
  const a = JSON.stringify(this.originalEnabled ?? null);
  const b = JSON.stringify(this.draftEnabled ?? null);
  return a !== b;
}
```

Render footer as `theme.fg(isDirty?"warning":"dim", isDirty ? "● unsaved — press Enter to save" : "enter save  esc close")`.

- [ ] **Step 4: Implement persist in `index.ts`**

```typescript
onPersist: async (next) => {
  await saveEnabledModels(next);
  ctx.ui.notify(`modelconf: saved ${next === undefined ? allModels.length : next.length} enabled models — reload to apply`, "info");
  // Try graceful reload; ignore if ctx.reload unavailable
  try { await (ctx as any).reload?.(); } catch {}
}
```

- [ ] **Step 5: Manual test — toggle loop**

In pi: `/modelconf`, press Space on 2 models, verify mark flips, footer shows unsaved, Enter saves, check `cat ~/.pi/agent/settings.json`, reopen `/modelconf` confirms persisted.

- [ ] **Step 6: Commit**

```
feat(modelconf): space toggles visibility and enter persists enabledModels
```

---

### Task 7: Fuzzy search (`/`)

**Files:**
- Modify: `./src/ui/ModelConfView.ts`
- Create: `./src/ui/SearchOverlay.ts` (optional inline input; can be inline in ModelConfView)
- Modify: `./index.ts` (no change, logic inside view)

**Interfaces:**
- Consumes: `fuzzyFilter` from `fuzzy.ts`
- Produces: search mode inside ModelConfView (no new external API).

Behavior:
- Pressing `/` enters search mode: an `Input` (from `@earendil-works/pi-tui`) appears at top/bottom, focused, with IME support (`Focusable` container — propagate `focused` to child Input per `docs/tui.md` container note).
- Typing filters `flatRows` via `fuzzyFilter(query, flatRows, r=>`${r.provider}/${r.modelId} ${r.name}`)`. Cursor resets to 0, scroll resets.
- `Esc` exits search (clears query), `Enter` keeps filtered view but exits input focus, Backspace edits query.
- Highlight matched rows? v1: just filtered list; v2 bonus: dim non-matching.
- Empty query returns full provider-grouped view.

- [ ] **Step 1: Verify docs/tui.md IME note — container must implement Focusable and propagate to Input**

Code sketch:

```typescript
import { Input, Container, type Focusable } from "@earendil-works/pi-tui";

class SearchOverlay extends Container implements Focusable {
  input = new Input({ placeholder: "fuzzy search…", onChange: ()=> this.opts.onChange(this.input.value) });
  private _focused = false;
  get focused(){ return this._focused; }
  set focused(v:boolean){ this._focused = v; this.input.focused = v; }
}
```

Or simpler: keep search as inline string + handleInput char insertion without full Input component (avoid IME complexity) — decision: use Input for correctness.

- [ ] **Step 2: Add state to ModelConfView**

```typescript
private searchActive = false;
private searchQuery = "";
private searchInput = new Input();
private filteredRows: ModelRow[] | null = null;
```

In `render`, if `searchActive`, prepend line: `theme.fg("accent", "/") + searchInput.render(...)`.

- [ ] **Step 3: Handle `/` key to enter search**

```typescript
if (!this.searchActive && data === "/") {
  this.searchActive = true;
  this.searchInput.focused = true;
  this.searchInput.value = "";
  tui.requestRender(); return;
}
if (this.searchActive) {
  if (data === "\x1b") { this.searchActive = false; this.searchInput.focused = false; this.filteredRows = null; this.searchQuery=""; }
  else if (data === "\r") { this.searchActive = false; this.searchInput.focused = false; }
  else { this.searchInput.handleInput?.(data); this.searchQuery = this.searchInput.value; this.filteredRows = fuzzyFilter(this.searchQuery, this.flatRows, r=>`${r.provider}/${r.modelId}`); this.cursorIndex = 0; }
  tui.requestRender(); return;
}
```

Route `handleInput` early to `searchInput` when active.

- [ ] **Step 4: Update rendering to use `filteredRows ?? flatRows` for flat navigation, but keep provider group rendering filtered (hide empty groups)**

In `render`, compute `rowsToShow = this.filteredRows ?? this.flatRows` but group by provider from that set.

- [ ] **Step 5: Manual test**

`/modelconf` → `/` → type `luna` → expect only `gpt-5.6-luna` etc remain; `Esc` returns; arrow navigation works within filtered.

- [ ] **Step 6: Commit**

```
feat(modelconf): fuzzy search on / with Input overlay
```

---

### Task 8: Bulk glob menu (`x`)

**Files:**
- Modify: `./src/ui/ModelConfView.ts`
- Create: `./src/ui/GlobMenu.ts`
- Modify: `./src/persistence.ts` (already has `applyBulk`, now used)
- Test: manual TUI

**Interfaces:**
- Consumes: `filterByGlob`, `applyBulk`, `loadEnabledModels`
- Produces: overlay dialog returned from `handleInput` when `x` pressed.

Behavior:
- `x` opens a centered modal (`Container` with bordered box) containing:
  - Input line: `Glob/keyword: [________]` (placeholder `e.g. *luna* or luna`)
  - Count preview live: `Matches 12 models`
  - Two actions: `Include all matches` (enable) and `Exclude all matches` (disable), selectable via `Tab`/`Arrow` or `i`/`e` shortcuts, `Enter` confirms, `Esc` cancels.
  - Footer: `Enter confirm  Esc cancel  Tab switch action`
- Pattern semantics: if pattern lacks `*`/`?`, treat as `*pattern*` (keyword substring, case-insensitive). This satisfies spec's "glob a keyword".
- On confirm, compute `matching = filterByGlob(pattern, allRows, r=>`${r.provider}/${r.modelId}`)` → `modelId`s, then `draftEnabled = applyBulk(draftEnabled, allIds, matchingIds, action)` → rebuild visibility → close modal → show transient notify `Included 12 / Excluded 5`.
- Does not auto-save; dirties draft like Space toggles (so Enter still needed to persist).

Modal implementation notes:
- Use `Container` + simple box drawing via `theme.fg("border", ...)` (check `examples/extensions/qna.ts` BorderedLoader pattern). Or reuse `SelectList` for action choice.
- Modal captures all input until closed (set `inGlobMenu = true` flag to route `handleInput` to modal).

- [ ] **Step 1: Write unit test for bulk include/exclude over keyword**

```typescript
import { filterByGlob } from "./glob.js";
import { applyBulk } from "./persistence.js";
const all = ["a/luna-1","a/luna-2","a/other"] as any;
const m = filterByGlob("luna", all.map(id=>({id})), x=>x.id);
assert.equal(m.length, 2);
let draft: string[]|undefined = undefined;
draft = applyBulk(draft, all as any, ["a/luna-1","a/luna-2"] as any, "exclude");
assert.deepEqual(draft, ["a/other"]);
console.log("bulk pass");
```

- [ ] **Step 2: Implement GlobMenu component**

```typescript
export class GlobMenu extends Container implements Focusable {
  input = new Input({ placeholder: "*luna* or luna" });
  action: "include"|"exclude" = "exclude";
  matches: ModelRow[] = [];
  constructor(private opts: { allRows: ModelRow[]; onConfirm: (pattern:string, action:"include"|"exclude", matches:ModelRow[])=>void; onCancel: ()=>void; tui: TUI; theme: any; }) { super(); this.addChild(this.input); }
  // Focusable propagation...
  handleInput(data:string){ ... }
  render(width:number): string[] { /* bordered box 60 chars wide centered */ }
}
```

Simpler v1: keep menu logic inside `ModelConfView` without separate file — inline state:

```typescript
private globOpen = false;
private globPattern = "";
private globAction: "include"|"exclude" = "exclude";
private globInput = new Input();
```

Render overlay as centered box when `globOpen`.

- [ ] **Step 3: Wire `x` key in ModelConfView.handleInput**

```typescript
if (!this.globOpen && data === "x") {
  this.globOpen = true; this.globInput.focused = true; this.globInput.value=""; this.globPattern=""; this.globAction="exclude";
  tui.requestRender(); return;
}
if (this.globOpen) {
  if (data === "\x1b") { this.globOpen=false; this.globInput.focused=false; tui.requestRender(); return; }
  if (data === "\t") { this.globAction = this.globAction==="exclude" ? "include" : "exclude"; tui.requestRender(); return; }
  if (data === "i") { this.globAction="include"; tui.requestRender(); return; }
  if (data === "e") { this.globAction="exclude"; tui.requestRender(); return; }
  if (data === "\r") {
    const pattern = this.globInput.value.trim();
    if (!pattern) return;
    const matches = filterByGlob(pattern, this.flatRows, r=>`${r.provider}/${r.modelId}`);
    this.draftEnabled = applyBulk(this.draftEnabled, this.allIds, matches.map(r=>`${r.provider}/${r.modelId}` as any), this.globAction);
    this.rebuildVisibility(); this.globOpen=false; this.globInput.focused=false;
    tui.requestRender(); return;
  }
  this.globInput.handleInput?.(data); tui.requestRender(); return;
}
```

Preview count: `const preview = filterByGlob(this.globInput.value || "*", this.flatRows, ...).length`.

- [ ] **Step 4: Render modal overlay**

In `render`, if `globOpen`, return overlay lines instead of main list OR composite: render main list dimmed then boxed menu. Simplest: return menu box full-screen centered:

```typescript
if (this.globOpen) {
  const count = filterByGlob(this.globInput.value||"", this.flatRows, r=>`${r.provider}/${r.modelId}`).length;
  return [
    theme.fg("accent", theme.bold("Bulk glob — include / exclude")),
    theme.fg("dim", "Keyword or glob pattern (e.g. luna or *luna*)"),
    `> ${this.globInput.render?.(width) ?? this.globInput.value}_`,
    theme.fg("dim", `Matches: ${count} models`),
    "",
    this.globAction==="include" ? theme.fg("success", "▶ Include (enable)") : theme.fg("dim", "  Include (enable)"),
    this.globAction==="exclude" ? theme.fg("warning", "▶ Exclude (disable)") : theme.fg("dim", "  Exclude (disable)"),
    theme.fg("dim", "Tab switch · i/e shortcut · Enter apply · Esc cancel"),
  ];
}
```

Polish with `Container` border for v2.

- [ ] **Step 5: Manual test**

`/modelconf` → `x` → type `luna` → see count `2` → `Tab` to `Include` → `Enter` → verify those rows now `◉` visible; press `x` → `luna` → `Exclude` → rows become `○`; `Enter` to save → check settings.

- [ ] **Step 6: Commit**

```
feat(modelconf): bulk glob menu on x for include/exclude by keyword
```

---

### Task 9: Polish, key legend, empty states, persistence edge cases & docs

**Files:**
- Modify: `./src/ui/ModelConfView.ts` (legend, empty state, scroll window, provider collapse via Enter? optional)
- Modify: `./README.md`
- Modify: `./index.ts` (keybinding `Ctrl+Alt+M` optional shortcut)
- Test: full manual pass + `npx tsc --noEmit`

**Interfaces:**
- Consumes: all previous
- Produces: shippable extension

- [ ] **Step 1: Add empty state when filter yields 0**

In `render`, if `rowsToShow.length === 0`, return `[theme.fg("warning", "No models match query"), theme.fg("dim","Press Esc to clear search")]`.

- [ ] **Step 2: Clamp scroll window to terminal height**

Compute `visibleHeight = Math.min(rowsToShow.length + providerHeaders, tui.height ?? 30) - 4`. Slice window around `cursorIndex`.

- [ ] **Step 3: Add keyboard shortcut registration (optional)**

In `index.ts`, add:
```typescript
pi.registerShortcut({ key: "m", ctrl: true, alt: true } as any, {
  description: "Open modelconf",
  handler: async (ctx) => { /* trigger same as /modelconf command */ }
});
```
Guard: if `Key` API differs, skip — doc shows `registerShortcut(KeyId)`; verify at impl time.

- [ ] **Step 4: Handle edge cases**

- `enabledModels` contains stale ids for removed models → ignore in `isVisible`, but keep in file until user re-saves (filter to `allIds` intersection on save).
- Save writes `undefined` (delete key) when all visible to keep file clean; writes explicit array when filtered.
- File missing → treat as `undefined` (all visible).
- Parse error → notify `settings.json invalid JSON` and treat as `undefined` without overwriting.
- Large catalogs (2000+ models from `models-store.json`) → ensure `fuzzyFilter` stays fast (limit to 200 results shown, scroll paginated).

- [ ] **Step 5: Write README.md**

```markdown
# modelconf

Per-provider model visibility manager.

## Usage
/modelconf
- ↑/↓ or j/k navigate, / to fuzzy search, space toggle, x bulk, enter save, esc cancel.

## Persistence
Writes `enabledModels` in `~/.pi/agent/settings.json`. After save, run `/reload` if models list not refreshed.
```

- [ ] **Step 6: Final checks**

Run:
```bash
npx tsc --noEmit --project ~/.pi/agent/extensions/modelconf/tsconfig.json
pi --help   # ensure extension loads without error
```
Manual: `/modelconf` → fuzzy `mini` → toggle → `x` → `*free*` exclude → `Enter` → `/reload` → `/model` picker confirms hidden.

- [ ] **Step 7: Commit**

```
docs(modelconf): final polish and README
```

---

## Verification Checklist

- [ ] `pi` starts, `/reload` shows no load errors for `modelconf`.
- [ ] `/modelconf` opens grouped list, provider headers with `visible/total`.
- [ ] `/` opens search input (IME cursor visible), typing filters list via fuzzy, `Esc` clears.
- [ ] `Space` flips `◉`/`○` and marks dirty (`● unsaved`), `Enter` writes `settings.json` and notifies, `Esc` with dirty prompts discard.
- [ ] `x` opens glob modal, typing `luna` matches substring, `Tab`/`i`/`e` switches include/exclude, `Enter` bulk-toggles draft, preview count correct.
- [ ] Save with all visible writes `enabledModels: undefined` (key removed); save with some hidden writes exact array; reload and reopen confirms persistence.
- [ ] Large provider (`opencode` ~ thousands in `models-store.json`) scrolls without overflow.
- [ ] `npx tsc --noEmit` passes.

## Risks & Mitigations

- **No public `settingsManager` API in ExtensionAPI** — mitigated by direct `fs` read/write to `~/.pi/agent/settings.json` + documented fallback; spike in Task 2 verifies path and `ctx as any` alternative.
- **IME cursor not showing** — ensure `Container implements Focusable` propagates `focused` to `Input` per `docs/tui.md`; test with CJK input.
- **Performance on 3000+ models** — fuzzyFilter is O(n*q) but n=~11000 max (from `models-store.json`); limit render window and debounce input if needed.
- **Extension not auto-discovered** — must be `~/.pi/agent/extensions/modelconf/index.ts` and `settings.json` `extensions` includes `"extensions/"`; verify via `/reload` logs.

## Out of Scope (v2)

- Provider-level collapse/expand toggle (could be `Enter` on header).
- Regex mode for glob menu.
- Project-local `.pi/settings.json` enabledModels merging.
- Undo history / diff preview before save.

