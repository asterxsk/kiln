import { applyBulk, toggleInEnabled } from "../persistence.js";
import type { ModelId } from "../persistence.js";
import { globToRegExp } from "../glob.js";
import { fuzzyFilter } from "../fuzzy.js";
import { filterByGlob } from "../glob.js";
// Minimal Component type to avoid requiring @earendil-works/pi-tui at build time.
// We mirror the pi-tui Component contract used by ctx.ui.custom.
export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

// Focusable contract per docs/tui.md — propagate focused to child Input
export interface Focusable {
  focused: boolean;
}

// ---- local helpers for width/truncation (fallback when pi-tui not available) ----

function stripAnsi(s: string): string {
  // strip CSI ...m, OSC 8 hyperlink, and APC cursor marker
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x1b\\/g, "").replace(/\x1b_pi:c\x07/g, "");
}

function visibleWidthFallback(s: string): number {
  const stripped = stripAnsi(s);
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    // crude wide char detection: CJK + emoji ranges
    if (cp >= 0x1100 && (
      cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6)
    )) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
  if (str[pos] !== "\x1b") return null;
  const next = str[pos + 1];
  if (next === "[") {
    let i = pos + 2;
    while (i < str.length) {
      const c = str[i];
      if ((c >= "0" && c <= "9") || c === ";" || c === ":" || c === "?" ) { i++; continue; }
      // final char
      i++;
      return { code: str.slice(pos, i), length: i - pos };
    }
    return null;
  }
  if (next === "]") {
    const end = str.indexOf("\x1b\\", pos);
    if (end !== -1) return { code: str.slice(pos, end + 2), length: end + 2 - pos };
    const bel = str.indexOf("\x07", pos);
    if (bel !== -1) return { code: str.slice(pos, bel + 1), length: bel + 1 - pos };
    return null;
  }
  if (str.startsWith("\x1b_pi:c\x07", pos)) return { code: "\x1b_pi:c\x07", length: 7 };
  return null;
}

function truncateFallback(text: string, maxWidth: number, ellipsis = "..."): string {
  if (maxWidth <= 0) return "";
  const vw = visibleWidthFallback(text);
  if (vw <= maxWidth) return text;
  const ellW = visibleWidthFallback(ellipsis);
  const target = maxWidth - ellW;
  if (target <= 0) {
    // truncate ellipsis itself if needed
    let out = "";
    let w = 0;
    let i = 0;
    while (i < text.length) {
      const ansi = extractAnsiCode(text, i);
      if (ansi) { out += ansi.code; i += ansi.length; continue; }
      // grapheme: take one codepoint
      const ch = text[i];
      // handle surrogate pair
      let grapheme = ch;
      if (ch.charCodeAt(0) >= 0xD800 && ch.charCodeAt(0) <= 0xDBFF && i + 1 < text.length) {
        grapheme = text.slice(i, i + 2);
      }
      const gw = visibleWidthFallback(grapheme);
      if (w + gw > maxWidth) break;
      out += grapheme;
      w += gw;
      i += grapheme.length;
    }
    return out;
  }
  let out = "";
  let w = 0;
  let i = 0;
  let pendingAnsi = "";
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) { pendingAnsi += ansi.code; out += ansi.code; i += ansi.length; continue; }
    let grapheme = text[i];
    if (grapheme.charCodeAt(0) >= 0xD800 && grapheme.charCodeAt(0) <= 0xDBFF && i + 1 < text.length) {
      grapheme = text.slice(i, i + 2);
    }
    const gw = visibleWidthFallback(grapheme);
    if (w + gw > target) break;
    out += grapheme;
    w += gw;
    i += grapheme.length;
  }
  out += ellipsis;
  // Append pending ansi resets? naive: ensure reset at end not needed
  return out;
}

// Try to use pi-tui's truncate if available at runtime (optional). For compile-time we use fallback.
let truncateToWidthFn: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string = truncateFallback;
try {
  // @ts-ignore - optional dynamic import may fail at build if module not installed; fallback is fine
  // We keep fallback as default; runtime override attempted via dynamic import is not critical
} catch {}

// ---------------------------------------------------------------------------
// Simple Input fallback — mimics @earendil-works/pi-tui Input for search mode
// Handles printable chars, backspace (\x7f, \x08), delete, left/right arrows.
// Propagates focused flag per Focusable contract. Fallback when pi-tui Input not resolvable.

class SimpleSearchInput implements Component, Focusable {
  value = "";
  focused = false;
  private cursor = 0;
  // Keep for compatibility with pi-tui Input shape
  getValue(): string { return this.value; }
  setValue(v: string): void { this.value = v; this.cursor = v.length; }

  handleInput(data: string): void {
    if (!data) return;
    // Handle bracketed paste markers — strip and insert content
    if (data.includes("\x1b[200~")) {
      const start = data.indexOf("\x1b[200~");
      const end = data.indexOf("\x1b[201~");
      if (end !== -1) {
        const paste = data.substring(start + 6, end);
        this.insertAtCursor(paste);
        const remaining = data.slice(end + 6);
        if (remaining) this.handleInput(remaining);
        return;
      } else {
        // incomplete paste marker — strip marker and insert rest
        data = data.replace("\x1b[200~", "");
      }
    }
    if (data.includes("\x1b[201~")) {
      data = data.replace("\x1b[201~", "");
    }

    // Special keys — handle one at a time if data contains escapes
    // Backspace: \x7f or \x08 or \b
    if (data === "\x7f" || data === "\x08" || data === "\b") {
      this.handleBackspace();
      return;
    }
    // Delete (forward): \x1b[3~
    if (data === "\x1b[3~") {
      this.handleDelete();
      return;
    }
    // Arrows for cursor movement within input
    if (data === "\x1b[D" || data === "\x1bOD") { // left
      if (this.cursor > 0) this.cursor--;
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") { // right
      if (this.cursor < this.value.length) this.cursor++;
      return;
    }
    if (data === "\x1b[H" || data === "\x1bOH" || data === "\x1b[1~") { // home
      this.cursor = 0;
      return;
    }
    if (data === "\x1b[F" || data === "\x1bOF" || data === "\x1b[4~") { // end
      this.cursor = this.value.length;
      return;
    }
    // Ctrl-U (kill line)
    if (data === "\x15") {
      this.value = "";
      this.cursor = 0;
      return;
    }
    // Ctrl-W (delete word backwards)
    if (data === "\x17") {
      this.deleteWordBackwards();
      return;
    }
    // If data looks like an escape sequence (arrow, etc.) not handled above and length >1, ignore
    if (data.startsWith("\x1b") && data.length > 1) {
      // Unknown escape — ignore (avoid inserting ESC into query)
      return;
    }
    // Ctrl-C / Ctrl-D etc — ignore
    if (data.length === 1 && data.charCodeAt(0) < 0x20) {
      return;
    }
    // Printable insertion — insert at cursor (support multi-char paste without bracket markers)
    // Filter out non-printable control chars
    let insert = "";
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) insert += ch;
    }
    if (insert) this.insertAtCursor(insert);
  }

  private insertAtCursor(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }
  private handleBackspace(): void {
    if (this.cursor > 0) {
      this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
      this.cursor--;
    }
  }
  private handleDelete(): void {
    if (this.cursor < this.value.length) {
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
    }
  }
  private deleteWordBackwards(): void {
    if (this.cursor === 0) return;
    let pos = this.cursor;
    while (pos > 0 && this.value[pos - 1] === " ") pos--;
    while (pos > 0 && this.value[pos - 1] !== " ") pos--;
    this.value = this.value.slice(0, pos) + this.value.slice(this.cursor);
    this.cursor = pos;
  }

  render(width: number): string[] {
    // Render with cursor marker when focused. Use \x1b_pi:c\x07 marker for IME if needed? Simple underscore.
    // Show placeholder when empty and not focused? When focused, show cursor.
    const cursorMark = "\x1b_pi:c\x07";
    let display: string;
    if (this.focused) {
      const before = this.value.slice(0, this.cursor);
      const after = this.value.slice(this.cursor);
      // Insert cursor marker + visual block; terminal will show cursor at marker
      display = before + cursorMark + (after.length > 0 ? after : " ");
      // Also truncate to width with visibleWidth handling? Keep simple truncation
      // Use truncateFallback to keep ANSI safe (cursorMark is ANSI-like)
      if (visibleWidthFallback(display) > width) {
        // simple scroll: show window around cursor
        const half = Math.floor(width / 2);
        let start = Math.max(0, this.cursor - half);
        // crude slice
        let slice = this.value.slice(start, start + width);
        const curInSlice = this.cursor - start;
        display = slice.slice(0, curInSlice) + cursorMark + slice.slice(curInSlice);
      }
    } else {
      display = this.value;
    }
    // Apply truncate for width
    const line = truncateFallback(display, width);
    return [line];
  }

  invalidate(): void {}
}

// ---------------------------------------------------------------------------

export interface ModelRow {
  id: string; // "provider/modelId"
  provider: string;
  modelId: string;
  visible: boolean;
  name?: string;
}

export interface ModelConfViewOpts {
  tui: any;
  theme: any;
  keybindings: any;
  allModels: Array<{ provider: string; id: string; name?: string }>;
  visibleSet: Set<string>;
  enabledRaw: string[] | undefined;
  onDone: (saved: boolean) => void;
  onPersist: (nextEnabled: string[] | undefined) => Promise<void>;
  allIds?: string[];
}

type ContentEntry =
  | { kind: "header"; provider: string }
  | { kind: "row"; row: ModelRow; flatIndex: number };

export class ModelConfView implements Component, Focusable {
  private tui: any;
  private theme: any;
  private keybindings: any;
  private onDone: (saved: boolean) => void;
  private _onPersist: (next: string[] | undefined) => Promise<void>;

  private rows: ModelRow[] = [];
  private sortedProviders: string[] = [];
  private rowsByProvider: Map<string, ModelRow[]> = new Map();
  private cursorIndex: number = 0;
  private collapsed: Set<string> = new Set();
  private originalEnabled: string[] | undefined;
  private draftEnabled: string[] | undefined;
  private allIds: string[] = [];
  private pendingDiscard = false;

  private activeProviderIndex: number = 0;
  private perProviderCursor: Map<string, number> = new Map();

  private searchActive = false;
  private searchQuery = "";
  private filteredRows: ModelRow[] | null = null;
  private searchInput: SimpleSearchInput;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    if (this.searchInput) this.searchInput.focused = v && this.searchActive;
    if (this.globInput) this.globInput.focused = v && this.globOpen;
  }

  private globOpen = false;
  private globAction: "include" | "exclude" = "exclude";
  private globInput: SimpleSearchInput;
  private lastBulkMessage: string | null = null;
  private lastBulkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ModelConfViewOpts) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.keybindings = opts.keybindings;
    this.onDone = opts.onDone;
    this._onPersist = opts.onPersist;

    this.searchInput = new SimpleSearchInput();
    try {
      const req: any = (globalThis as any).require ?? (typeof require !== "undefined" ? require : undefined);
      if (req) {
        let mod: any;
        try { mod = req("@earendil-works/pi-tui"); } catch { try { mod = req("@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"); } catch {} }
        if (mod?.Input) {
          const real = new mod.Input();
          if (typeof real.value === "string" || typeof real.getValue === "function") {
            const wrapped: any = real;
            if (!("value" in wrapped) || typeof wrapped.value !== "string") {
              Object.defineProperty(wrapped, "value", {
                get() { return typeof wrapped.getValue === "function" ? wrapped.getValue() : wrapped._value ?? ""; },
                set(v: string) { if (typeof wrapped.setValue === "function") wrapped.setValue(v); else wrapped._value = v; },
                configurable: true,
              });
            }
            this.searchInput = wrapped;
          }
        }
      }
    } catch {}
    this.globInput = new SimpleSearchInput();
    try { (this.globInput as any).placeholder = "e.g. *luna* or luna"; } catch {}

    const all = opts.allModels ?? [];
    this.rows = all.map((m) => {
      const id = `${m.provider}/${m.id}`;
      return {
        id,
        provider: m.provider,
        modelId: m.id,
        visible: opts.visibleSet.has(id),
        name: m.name ?? m.id,
      } as ModelRow;
    });

    this.rows.sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.modelId.localeCompare(b.modelId);
    });

    this.rowsByProvider = new Map();
    for (const r of this.rows) {
      const arr = this.rowsByProvider.get(r.provider);
      if (arr) arr.push(r);
      else this.rowsByProvider.set(r.provider, [r]);
    }
    this.sortedProviders = [...this.rowsByProvider.keys()].sort((a, b) => a.localeCompare(b));

    const ordered: ModelRow[] = [];
    for (const p of this.sortedProviders) {
      const grp = this.rowsByProvider.get(p)!;
      grp.sort((a, b) => a.modelId.localeCompare(b.modelId));
      ordered.push(...grp);
    }
    this.rows = ordered;

    this.activeProviderIndex = 0;
    this.perProviderCursor = new Map();
    for (const p of this.sortedProviders) this.perProviderCursor.set(p, 0);
    const initActive = this.activeProvider;
    if (initActive) {
      const base = this.rowsByProvider.get(initActive) ?? [];
      this.cursorIndex = base.length > 0 ? 0 : -1;
    } else {
      this.cursorIndex = this.rows.length > 0 ? 0 : -1;
    }

    this.allIds = opts.allIds ?? all.map((m) => `${m.provider}/${m.id}`);
    this.originalEnabled = opts.enabledRaw === undefined ? undefined : [...opts.enabledRaw];
    this.draftEnabled = opts.enabledRaw === undefined ? undefined : [...opts.enabledRaw];
    this.pendingDiscard = false;
  }

  getVisibleCount(): number {
    return this.rows.filter((r) => r.visible).length;
  }

  private isDirty(): boolean {
    const a = this.originalEnabled;
    const b = this.draftEnabled;
    if (a === undefined && b === undefined) return false;
    if (a === undefined || b === undefined) return true;
    if (a.length !== b.length) return true;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return JSON.stringify(sa) !== JSON.stringify(sb);
  }

  private rebuildVisibility(): void {
    const draft = this.draftEnabled;
    if (draft === undefined || draft.length === 0) {
      for (const r of this.rows) r.visible = true;
      return;
    }
    const hidden = draft as string[];
    const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const stripThinking = (p: string) => {
      const idx = p.lastIndexOf(":");
      if (idx !== -1 && VALID_THINKING.has(p.slice(idx + 1))) return p.slice(0, idx);
      return p;
    };
    const matchesPattern = (ref: string, pattern: string): boolean => {
      const pat = stripThinking(pattern);
      const lowerRef = ref.toLowerCase();
      const lowerPat = pat.toLowerCase();
      const bareId = ref.split("/").slice(1).join("/").toLowerCase();
      const hasGlob = /[*?[\]]/.test(pat);
      if (hasGlob) {
        const rx = globToRegExp(pat);
        if (rx.test(ref)) return true;
        if (rx.test(bareId)) return true;
        return false;
      }
      return lowerRef === lowerPat || bareId === lowerPat;
    };
    for (const r of this.rows) {
      let isHidden = false;
      for (const pat of hidden) {
        if (matchesPattern(r.id, pat)) { isHidden = true; break; }
      }
      r.visible = !isHidden;
    }
  }

  private safeFg(color: string, text: string): string {
    try {
      if (this.theme && typeof this.theme.fg === "function") {
        return this.theme.fg(color, text);
      }
    } catch {}
    return text;
  }

  private safeBold(text: string): string {
    try {
      if (this.theme && typeof this.theme.bold === "function") {
        return this.theme.bold(text);
      }
    } catch {}
    return text;
  }

  private safeBg(color: string, text: string): string {
    try {
      if (this.theme && typeof this.theme.bg === "function") {
        return this.theme.bg(color, text);
      }
    } catch {}
    return text;
  }

  private highlight(text: string): string {
    try {
      if (this.theme && typeof this.theme.bg === "function") {
        try {
          const v = this.theme.bg("selectedBg", text);
          if (v !== text) return v;
        } catch {}
        try {
          const v2 = (this.theme as any).bg("selection", text);
          if (v2 !== text) return v2;
        } catch {}
      }
    } catch {}
    try {
      if (this.theme && typeof this.theme.fg === "function") {
        return this.theme.fg("accent", text);
      }
    } catch {}
    return `› ${text}`;
  }

  private isProviderCollapsed(provider: string): boolean {
    return this.collapsed.has(provider);
  }

  private get activeProvider(): string | undefined {
    if (this.sortedProviders.length === 0) return undefined;
    const idx = Math.max(0, Math.min(this.activeProviderIndex, this.sortedProviders.length - 1));
    return this.sortedProviders[idx];
  }

  private get activeRows(): ModelRow[] {
    const p = this.activeProvider;
    if (!p) return [];
    return this.rowsByProvider.get(p) ?? [];
  }

  private get rowsToShow(): ModelRow[] {
    const base = this.activeRows;
    if (this.filteredRows !== null) {
      const filteredForActive = this.filteredRows.filter((r) => r.provider === this.activeProvider);
      if (filteredForActive.length !== this.filteredRows.length) return filteredForActive;
      return this.filteredRows;
    }
    return base;
  }

  private cursorRow(): ModelRow | undefined {
    const list = this.rowsToShow;
    if (this.cursorIndex < 0 || this.cursorIndex >= list.length) return undefined;
    return list[this.cursorIndex];
  }

  private getCurrentProvider(): string | undefined {
    return this.activeProvider;
  }

  private switchProvider(delta: number): void {
    if (this.sortedProviders.length <= 1) return;
    const curProvider = this.activeProvider;
    if (curProvider) this.perProviderCursor.set(curProvider, this.cursorIndex);
    let next = this.activeProviderIndex + delta;
    next = (next + this.sortedProviders.length) % this.sortedProviders.length;
    this.activeProviderIndex = next;
    const nextProvider = this.activeProvider!;
    let saved = this.perProviderCursor.get(nextProvider);
    if (saved === undefined) saved = 0;
    const targetRows = this.rowsToShowForProvider(nextProvider);
    if (targetRows.length === 0) this.cursorIndex = -1;
    else this.cursorIndex = Math.max(0, Math.min(saved, targetRows.length - 1));
    if (this.filteredRows !== null && this.searchQuery.trim()) {
      this.recomputeFilteredForActive();
      const after = this.rowsToShow;
      if (after.length === 0) this.cursorIndex = -1;
      else this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, after.length - 1));
    }
  }

  private rowsToShowForProvider(provider: string): ModelRow[] {
    const base = this.rowsByProvider.get(provider) ?? [];
    if (this.filteredRows !== null) {
      const anyForProvider = this.filteredRows.some((r) => r.provider === provider);
      if (anyForProvider) return this.filteredRows.filter((r) => r.provider === provider);
      if (this.searchQuery.trim()) {
        try {
          return fuzzyFilter(this.searchQuery, base, (r) => `${r.provider}/${r.modelId} ${r.name ?? ""}`);
        } catch { return []; }
      }
      return [];
    }
    return base;
  }

  private recomputeFilteredForActive(): void {
    const q = this.searchQuery;
    if (!q.trim()) {
      this.filteredRows = null;
      return;
    }
    const base = this.activeRows;
    try {
      this.filteredRows = fuzzyFilter(q, base, (r) => `${r.provider}/${r.modelId} ${r.name ?? ""}`);
    } catch {
      this.filteredRows = null;
    }
  }

  private renderTabBar(width: number): string {
    if (this.sortedProviders.length === 0) return this.safeFg("dim", "  (no providers)");
    const tabs: { styled: string; width: number }[] = [];
    for (let i = 0; i < this.sortedProviders.length; i++) {
      const p = this.sortedProviders[i];
      const group = this.rowsByProvider.get(p) ?? [];
      const vis = group.filter((r) => r.visible).length;
      const total = group.length;
      const count = `${vis}/${total}`;
      const rawLabel = `${p} ${count}`;
      let styled: string;
      if (i === this.activeProviderIndex) {
        const inner = ` [${rawLabel}] `;
        let hl = inner;
        try {
          const bgged = this.safeBg("selection", inner);
          if (bgged !== inner) hl = bgged;
          else hl = this.safeFg("accent", this.safeBold(inner));
        } catch {
          hl = this.safeFg("accent", this.safeBold(inner));
        }
        styled = hl;
      } else {
        styled = this.safeFg("dim", ` [${rawLabel}] `);
      }
      const w = visibleWidthFallback(stripAnsi(styled));
      tabs.push({ styled, width: w });
    }
    let totalW = tabs.reduce((s, t) => s + t.width, 0) + Math.max(0, tabs.length - 1);
    if (totalW <= width) {
      return tabs.map((t) => t.styled).join("");
    }
    let start = this.activeProviderIndex;
    let end = this.activeProviderIndex + 1;
    let curW = tabs[this.activeProviderIndex].width;
    let left = this.activeProviderIndex - 1;
    let right = this.activeProviderIndex + 1;
    while (left >= 0 || right < tabs.length) {
      let expanded = false;
      if (left >= 0) {
        const need = curW + 1 + tabs[left].width;
        if (need <= width - 4) {
          curW = need;
          start = left;
          left--;
          expanded = true;
        }
      }
      if (right < tabs.length) {
        const need = curW + 1 + tabs[right].width;
        if (need <= width - 4) {
          curW = need;
          end = right + 1;
          right++;
          expanded = true;
        }
      }
      if (!expanded) break;
    }
    const visible = tabs.slice(start, end);
    let out = visible.map((t) => t.styled).join("");
    if (start > 0) out = this.safeFg("dim", "‹ ") + out;
    if (end < tabs.length) out = out + this.safeFg("dim", " ›");
    return this.truncate(out, width);
  }

  private getAvailableHeight(): number {
    let h: number | undefined;
    try {
      const term = (this.tui as any)?.terminal;
      if (term) {
        if (typeof term.rows === "number") h = term.rows;
        else if (typeof term.height === "number") h = term.height;
        else if (typeof term.getSize === "function") {
          const sz = term.getSize();
          if (sz && typeof sz.rows === "number") h = sz.rows;
        }
      }
    } catch {}
    if (h === undefined || h === null) {
      try {
        const c: any = (globalThis as any).process?.stdout;
        if (c && typeof c.rows === "number") h = c.rows;
      } catch {}
    }
    if (h === undefined || h === null || h <= 0) h = 24;
    const searchExtra = this.searchActive ? 1 : (this.filteredRows !== null && this.searchQuery ? 1 : 0);
    // Half-screen: reserve half the terminal height for the list
    const half = Math.floor(h / 2);
    // Account for chrome: title + 2 dividers + tab bar + blank spacer + status + 2-line footer
    const chrome = 8 + searchExtra;
    const avail = Math.max(5, half - chrome);
    return Math.min(avail, 20);
  }

  private truncate(text: string, width: number): string {
    try {
      return truncateToWidthFn(text, width);
    } catch {
      return truncateFallback(text, width);
    }
  }

  render(width: number): string[] {
    if (this.globOpen) {
      const boxWidth = Math.min(64, Math.max(42, width - 6));
      const inner = boxWidth - 2;
      const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
      const pad = " ".repeat(leftPad);
      let count = 0;
      try {
        const curVal: string = ((): string => {
          const gi: any = this.globInput as any;
          if (typeof gi.getValue === "function") return gi.getValue();
          if (typeof gi.value === "string") return gi.value;
          return String(gi.value ?? "");
        })();
        let pat = curVal.trim().replace(/^\/+/, "");
        if (pat) {
          const activeBase = this.activeRows;
          const m = filterByGlob(pat, activeBase, (r) => `${r.provider}/${r.modelId} ${r.name ?? ""}`);
          count = m.length;
        } else {
          count = 0;
        }
      } catch { count = 0; }
      const top = this.safeFg("dim", "┌" + "─".repeat(inner) + "┐");
      const bottom = this.safeFg("dim", "└" + "─".repeat(inner) + "┘");
      const side = (innerText: string): string => {
        const t = this.truncate(innerText, inner);
        let vw = 0;
        try { vw = visibleWidthFallback(stripAnsi(t)); } catch { vw = t.length; }
        const spaces = Math.max(0, inner - vw);
        return this.safeFg("dim", "│") + t + " ".repeat(spaces) + this.safeFg("dim", "│");
      };
      const emptySide = this.safeFg("dim", "│") + " ".repeat(inner) + this.safeFg("dim", "│");
      const title = this.safeFg("accent", this.safeBold("Bulk glob — include / exclude"));
      const providerHint = this.activeProvider ? this.safeFg("dim", `in provider: ${this.activeProvider}`) : this.safeFg("dim", "Keyword or glob pattern (e.g. luna or *luna*)");
      const desc = this.safeFg("dim", "Keyword or glob pattern (e.g. luna or *luna*) — scoped to active provider");
      let inputInner = "";
      try {
        const gi: any = this.globInput as any;
        let rendered = "";
        if (typeof gi.render === "function") {
          const arr = gi.render(Math.max(10, inner - 16));
          rendered = (arr && arr[0]) ? arr[0] : (gi.value ?? "");
        } else {
          rendered = gi.value ?? "";
        }
        if (!rendered || !String(rendered).trim()) {
          rendered = this.safeFg("dim", "e.g. *luna* or luna");
        }
        inputInner = `Glob/keyword: [${rendered}]`;
      } catch {
        inputInner = "Glob/keyword: [" + this.safeFg("dim", "e.g. *luna* or luna") + "]";
      }
      const provLabel = this.activeProvider ?? "unknown";
      const countLine = count === 0
        ? this.safeFg("warning", `Matches in ${provLabel}: 0 — nothing to apply`)
        : this.safeFg("dim", `Matches in ${provLabel}: ${count}`);
      const incSelected = this.globAction === "include";
      const excSelected = this.globAction === "exclude";
      const incLine = incSelected ? this.safeFg("success", "▶ Include (enable)") : this.safeFg("dim", "  Include (enable)");
      const excLine = excSelected ? this.safeFg("warning", "▶ Exclude (disable)") : this.safeFg("dim", "  Exclude (disable)");
      const hint = this.safeFg("dim", "↑↓ / Tab switch · Enter apply · Esc cancel  •  / type keyword");
      const out: string[] = [];
      out.push("");
      out.push(pad + top);
      out.push(pad + side(title));
      out.push(pad + side(desc));
      out.push(pad + emptySide);
      out.push(pad + side(providerHint));
      out.push(pad + side(inputInner));
      out.push(pad + side(countLine));
      out.push(pad + emptySide);
      out.push(pad + side(incLine));
      out.push(pad + side(excLine));
      out.push(pad + emptySide);
      out.push(pad + side(hint));
      out.push(pad + bottom);
      return out.map((l) => this.truncate(l, width));
    }
    const lines: string[] = [];
    const total = this.rows.length;
    const visible = this.getVisibleCount();
    const dirtyMark = this.isDirty() ? this.safeFg("warning", "  ● unsaved") : "";
    const titleText = this.safeFg("accent", this.safeBold("modelconf")) + this.safeFg("dim", `  ${total} models  ${visible} visible`) + dirtyMark;
    lines.push(this.truncate(titleText, width));
    lines.push(this.truncate(this.safeFg("dim", "─".repeat(Math.max(0, width))), width));
    lines.push(this.truncate(this.renderTabBar(width), width));
    lines.push(this.truncate(this.safeFg("dim", "─".repeat(Math.max(0, width))), width));
    if (this.searchActive) {
      const inputWidth = Math.max(10, width - 4);
      const rendered = this.searchInput.render(inputWidth);
      const inputLine = rendered[0] ?? (this.searchInput as any).value ?? "";
      const prefix = this.safeFg("accent", "/ ");
      const line = prefix + inputLine;
      lines.push(this.truncate(line, width));
    } else if (this.filteredRows !== null && this.searchQuery) {
      const hint = this.safeFg("dim", `filtered in ${this.activeProvider ?? ""}: "${this.searchQuery}" (${this.rowsToShow.length}/${this.activeRows.length})  •  Esc to clear  •  / to search`);
      lines.push(this.truncate(hint, width));
    }
    const rowsToShow = this.rowsToShow;
    if (rowsToShow.length === 0) {
      if (this.filteredRows !== null) {
        const q = this.searchQuery;
        const prov = this.activeProvider ?? "provider";
        lines.push(this.truncate(this.safeFg("warning", `  No models match '${q}' in ${prov}`), width));
        lines.push(this.truncate(this.safeFg("dim", "  Press Esc to clear filter"), width));
      } else if (this.sortedProviders.length === 0) {
        lines.push(this.truncate(this.safeFg("dim", "  No providers configured"), width));
      } else {
        lines.push(this.truncate(this.safeFg("dim", `  No models in ${this.activeProvider ?? "provider"}`), width));
      }
    } else {
      const maxVisible = this.getAvailableHeight();
      let start = 0;
      let end = rowsToShow.length;
      if (rowsToShow.length > maxVisible) {
        const cursor = this.cursorIndex;
        const half = Math.floor(maxVisible / 2);
        start = Math.max(0, Math.min(cursor - half, rowsToShow.length - maxVisible));
        end = Math.min(start + maxVisible, rowsToShow.length);
      }
      for (let idx = start; idx < end; idx++) {
        const row = rowsToShow[idx];
        const isCursor = this.cursorIndex === idx;
        const mark = row.visible ? this.safeFg("success", "◉") : this.safeFg("dim", "○");
        const labelPart = `${mark} ${row.modelId}`;
        const dimName = row.name && row.name !== row.modelId ? this.safeFg("dim", ` ${row.name}`) : "";
        let rawLine = `${labelPart}${dimName}`;
        rawLine = `  ${rawLine}`;
        let rendered: string;
        if (isCursor) {
          const highlighted = this.highlight(rawLine);
          rendered = this.truncate(highlighted, width);
        } else {
          rendered = this.truncate(rawLine, width);
        }
        lines.push(rendered);
      }
      if (rowsToShow.length > maxVisible) {
        const pos = this.cursorIndex >= 0 ? this.cursorIndex + 1 : 0;
        const indicator = this.safeFg("dim", `  (${pos}/${rowsToShow.length}) in ${this.activeProvider ?? ""}`);
        lines.push(this.truncate(indicator, width));
      }
    }
    lines.push("");
    if (this.pendingDiscard) {
      const msg = this.safeFg("warning", "Discard changes? (y/N)") + this.safeFg("dim", "  y: discard  n: keep editing  Esc: discard");
      lines.push(this.truncate(msg, width));
    } else if (this.lastBulkMessage) {
      const isInc = this.lastBulkMessage.startsWith("Included") || this.lastBulkMessage.startsWith("Enabled");
      const bulk = this.safeFg(isInc ? "success" : "warning", this.lastBulkMessage) + this.safeFg("dim", this.isDirty() ? "  •  ● unsaved — Enter save" : "");
      lines.push(this.truncate(bulk, width));
    } else if (this.isDirty()) {
      lines.push(this.truncate(this.safeFg("warning", "● unsaved — press Enter to save"), width));
    } else if (this.searchActive) {
      lines.push(this.truncate(this.safeFg("dim", "filtering — Esc clear  •  Enter keep filter"), width));
    } else {
      const countLine = this.safeFg("dim", `${visible} visible / ${total} total`);
      lines.push(this.truncate(countLine, width));
    }
    // --- Persistent keybinds footer — always visible at bottom (all binds) ---
    const kb1 = "Tab/⇧Tab  ←→ switch provider │ ↑↓/j k  Home/End navigate │ Space toggle │ / filter";
    const kb2 = "x bulk glob │ d toggle all in provider │ Enter save │ Esc/q close";
    const sep = this.safeFg("dim", " │ ");
    // If terminal is wide enough, show in one line; otherwise split into two
    const oneLine = `${kb1} │ ${kb2}`;
    let footerLines: string[];
    try {
      const w = visibleWidthFallback(stripAnsi(oneLine));
      if (w + 2 <= width) {
        footerLines = [this.safeFg("dim", oneLine)];
      } else {
        footerLines = [this.safeFg("dim", kb1), this.safeFg("dim", kb2)];
      }
    } catch {
      footerLines = [this.safeFg("dim", kb1), this.safeFg("dim", kb2)];
    }
    for (const fl of footerLines) lines.push(this.truncate(fl, width));
    return lines.map((l) => this.truncate(l, width));
  }

  handleInput(data: string): void {
    if (!data) return;
    const tryKb = (keyId: string): boolean => {
      try {
        if (this.keybindings) {
          if (typeof this.keybindings.matches === "function" && this.keybindings.matches(data, keyId)) return true;
          if (typeof this.keybindings.match === "function" && this.keybindings.match(data, keyId)) return true;
        }
      } catch {}
      return false;
    };
    if (this.pendingDiscard) {
      if (data === "y" || data === "Y") {
        this.pendingDiscard = false;
        this.onDone(false);
        return;
      }
      if (data === "n" || data === "N") {
        this.pendingDiscard = false;
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
      const isEscPend = data === "\x1b" || tryKb("escape") || data.includes("\x1b[27");
      if (isEscPend) {
        this.pendingDiscard = false;
        this.onDone(false);
        return;
      }
      return;
    }
    if (this.globOpen) {
      const isEscKitty = data.includes("\x1b[27");
      const isEscGlob = data === "\x1b" || tryKb("escape") || isEscKitty;
      const isEnterGlob = data === "\r" || data === "\n" || data === "\r\n" || data.includes("\r") || data.includes("\n") || tryKb("enter") || tryKb("return");
      if (isEscGlob) {
        this.globOpen = false;
        try { (this.globInput as any).focused = false; } catch {}
        this._focused = true;
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
      if (data === "\t" || data === "\x1b[Z") {
        this.globAction = this.globAction === "exclude" ? "include" : "exclude";
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
      if (data === "\x1b[A" || data === "\x1bOA" || data === "\x1b[B" || data === "\x1bOB" || data === "\x1b[D" || data === "\x1bOD" || data === "\x1b[C" || data === "\x1bOC") {
        this.globAction = this.globAction === "exclude" ? "include" : "exclude";
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }

      if (isEnterGlob) {
        let pattern = "";
        try {
          const gi: any = this.globInput as any;
          if (typeof gi.getValue === "function") pattern = gi.getValue();
          else if (typeof gi.value === "string") pattern = gi.value;
          else pattern = String(gi.value ?? "");
        } catch { pattern = (this.globInput as any).value ?? ""; }
        pattern = pattern.trim().replace(/^\/+/, "");
        if (!pattern) return;
        let matches: ModelRow[] = [];
        try { matches = filterByGlob(pattern, this.activeRows, (r) => `${r.provider}/${r.modelId} ${r.name ?? ""}`); } catch { matches = []; }
        if (matches.length === 0) {
          try { this.tui?.requestRender?.(); } catch {}
          return;
        }
        const ids = matches.map((r) => `${r.provider}/${r.modelId}` as ModelId);
        this.draftEnabled = applyBulk(this.draftEnabled as any, this.allIds as unknown as ModelId[], ids, this.globAction) as any;
        this.rebuildVisibility();
        this.globOpen = false;
        try { (this.globInput as any).focused = false; } catch {}
        this._focused = true;
        const verb = this.globAction === "include" ? "Included" : "Excluded";
        const prov = this.activeProvider ?? "";
        this.lastBulkMessage = `${verb} ${matches.length} in ${prov}`;
        if (this.lastBulkTimer) { try { clearTimeout(this.lastBulkTimer); } catch {} }
        this.lastBulkTimer = setTimeout(() => { this.lastBulkMessage = null; try { this.tui?.requestRender?.(); } catch {} }, 4000) as any;
        if (this.cursorIndex >= this.rowsToShow.length) this.cursorIndex = Math.max(0, this.rowsToShow.length - 1);
        if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
      try { (this.globInput as any).handleInput?.(data); } catch {}
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (!this.searchActive && data === "/") {
      this.searchActive = true;
      this.searchInput.focused = true;
      this._focused = true;
      if (typeof (this.searchInput as any).setValue === "function") (this.searchInput as any).setValue("");
      else (this.searchInput as any).value = "";
      this.searchQuery = "";
      if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
      this.cursorIndex = this.rowsToShow.length > 0 ? 0 : -1;
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (this.searchActive) {
      const isEscKitty = data.includes("\x1b[27");
      const isEsc = data === "\x1b" || tryKb("escape") || isEscKitty;
      const isEnter = data === "\r" || data === "\n" || data === "\r\n" || data.includes("\r") || data.includes("\n") || tryKb("enter") || tryKb("return");
      if (data === "\t" || data === "\x1b[Z") {
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
      if (isEsc) {
        this.searchActive = false;
        this.searchInput.focused = false;
        this.filteredRows = null;
        this.searchQuery = "";
        if (typeof (this.searchInput as any).setValue === "function") (this.searchInput as any).setValue("");
        else (this.searchInput as any).value = "";
        const prov = this.activeProvider;
        if (prov) {
          const saved = this.perProviderCursor.get(prov);
          const list = this.rowsToShow;
          if (list.length === 0) this.cursorIndex = -1;
          else this.cursorIndex = saved !== undefined ? Math.max(0, Math.min(saved, list.length - 1)) : 0;
        } else {
          this.cursorIndex = this.rowsToShow.length > 0 ? 0 : -1;
        }
        try { this.tui?.requestRender?.(); } catch {}
        return;
      } else if (isEnter) {
        this.searchActive = false;
        this.searchInput.focused = false;
        if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
        try { this.tui?.requestRender?.(); } catch {}
        return;
      } else {
        try { (this.searchInput as any).handleInput?.(data); } catch {}
        let q: string = "";
        try {
          const si: any = this.searchInput;
          if (typeof si.getValue === "function") q = si.getValue();
          else if (typeof si.value === "string") q = si.value;
          else q = String(si.value ?? "");
        } catch { q = (this.searchInput as any).value ?? ""; }
        this.searchQuery = q;
        if (!q.trim()) {
          this.filteredRows = null;
          const prov = this.activeProvider;
          if (prov) {
            const saved = this.perProviderCursor.get(prov);
            this.cursorIndex = saved !== undefined ? Math.max(0, Math.min(saved, this.activeRows.length - 1)) : 0;
            if (this.activeRows.length === 0) this.cursorIndex = -1;
          } else {
            this.cursorIndex = 0;
          }
        } else {
          try {
            const base = this.activeRows;
            this.filteredRows = fuzzyFilter(q, base, (r) => `${r.provider}/${r.modelId} ${r.name ?? ""}`);
          } catch {
            this.filteredRows = null;
          }
          this.cursorIndex = this.rowsToShow.length > 0 ? 0 : -1;
        }
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
    }
    if (data === "\t" || data === "\x09") {
      this.switchProvider(1);
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (data === "\x1b[Z") {
      this.switchProvider(-1);
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (!this.globOpen && !this.searchActive && (data === "d" || data === "D")) {
      const active = this.activeRows;
      if (active.length === 0) return;
      const vis = active.filter((r) => r.visible).length;
      const allVisible = vis === active.length;
      const ids = active.map((r) => `${r.provider}/${r.modelId}` as ModelId);
      if (allVisible) {
        this.draftEnabled = applyBulk(this.draftEnabled as any, this.allIds as unknown as ModelId[], ids, "exclude") as any;
        this.lastBulkMessage = `Disabled all ${ids.length} in ${this.activeProvider ?? "provider"}`;
      } else {
        this.draftEnabled = applyBulk(this.draftEnabled as any, this.allIds as unknown as ModelId[], ids, "include") as any;
        this.lastBulkMessage = `Enabled all ${ids.length} in ${this.activeProvider ?? "provider"}`;
      }
      this.rebuildVisibility();
      if (this.lastBulkTimer) { try { clearTimeout(this.lastBulkTimer); } catch {} }
      this.lastBulkTimer = setTimeout(() => { this.lastBulkMessage = null; try { this.tui?.requestRender?.(); } catch {} }, 4000) as any;
      if (this.cursorIndex >= this.rowsToShow.length) this.cursorIndex = Math.max(0, this.rowsToShow.length - 1);
      if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (!this.globOpen && !this.searchActive && (data === "x" || data === "X")) {
      if (this.lastBulkTimer) { try { clearTimeout(this.lastBulkTimer); } catch {} this.lastBulkTimer = null; }
      this.globOpen = true;
      this.globAction = "exclude";
      this._focused = true;
      try {
        const gi: any = this.globInput as any;
        if (typeof gi.setValue === "function") gi.setValue("");
        else gi.value = "";
        gi.focused = true;
      } catch {}
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    const isEscKitty = data.includes("\x1b[27");
    const isEsc = data === "\x1b" || tryKb("escape") || isEscKitty;
    const isQ = data === "q" || data === "Q";
    if ((isEsc || isQ) && this.filteredRows !== null) {
      this.filteredRows = null;
      this.searchQuery = "";
      if (typeof (this.searchInput as any).setValue === "function") (this.searchInput as any).setValue("");
      else (this.searchInput as any).value = "";
      this.searchInput.focused = false;
      this.searchActive = false;
      const prov = this.activeProvider;
      if (prov) {
        const saved = this.perProviderCursor.get(prov);
        const list = this.activeRows;
        if (list.length === 0) this.cursorIndex = -1;
        else this.cursorIndex = saved !== undefined ? Math.max(0, Math.min(saved, list.length - 1)) : 0;
      } else {
        this.cursorIndex = this.rowsToShow.length > 0 ? 0 : -1;
      }
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (isEsc || isQ) {
      if (this.isDirty()) {
        this.pendingDiscard = true;
        try { this.tui?.requestRender?.(); } catch {}
        return;
      }
      this.onDone(false);
      return;
    }
    if (data === " ") {
      const row = this.cursorRow();
      if (!row) return;
      const modelId = `${row.provider}/${row.modelId}` as ModelId;
      // Hide/show operates on the full model list (this.allIds is the full registry),
      // even though the view is scoped to configured providers. This ensures toggling
      // a model affects the main full enabledModels list, not just the scoped subset.
      this.draftEnabled = toggleInEnabled(modelId, this.draftEnabled, this.allIds as ModelId[]);
      this.rebuildVisibility();
      this.pendingDiscard = false;
      if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    const isEnter = data === "\r" || data === "\n" || data === "\r\n" || tryKb("enter") || tryKb("return");
    const isEnterRaw = isEnter || data.includes("\r") || data.includes("\n");
    if (isEnterRaw) {
      const toSave = this.draftEnabled;
      Promise.resolve(this._onPersist(toSave as any)).then(() => {
        this.onDone(true);
      }).catch(() => {
        try { this.tui?.requestRender?.(); } catch {}
      });
      return;
    }
    // Left/Right also switch provider (alternative to Tab/Shift-Tab) when not in search/glob
    const isLeft = data === "\x1b[D" || data === "\x1bOD" || tryKb("left");
    const isRight = data === "\x1b[C" || data === "\x1bOC" || tryKb("right");
    if (isLeft) {
      this.switchProvider(-1);
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    if (isRight) {
      this.switchProvider(1);
      try { this.tui?.requestRender?.(); } catch {}
      return;
    }
    let handled = false;
    const isUp = data === "k" || data === "\x1b[A" || data === "\x1bOA" || tryKb("up") || tryKb("k");
    const isDown = data === "j" || data === "\x1b[B" || data === "\x1bOB" || tryKb("down") || tryKb("j");
    const isHome = data === "g" || data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH" || tryKb("home") || tryKb("g");
    const isEnd = data === "G" || data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF" || tryKb("end") || tryKb("G");
    const navList = this.rowsToShow;
    if (isUp) {
      if (navList.length > 0) {
        const next = (this.cursorIndex - 1 + navList.length) % navList.length;
        this.cursorIndex = next;
        if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
        handled = true;
      }
    } else if (isDown) {
      if (navList.length > 0) {
        const next = (this.cursorIndex + 1) % navList.length;
        this.cursorIndex = next;
        if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
        handled = true;
      }
    } else if (isHome) {
      if (navList.length > 0) {
        this.cursorIndex = 0;
        if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
        handled = true;
      }
    } else if (isEnd) {
      if (navList.length > 0) {
        this.cursorIndex = navList.length - 1;
        if (this.activeProvider) this.perProviderCursor.set(this.activeProvider, this.cursorIndex);
        handled = true;
      }
    }
    if (handled) {
      try { this.tui?.requestRender?.(); } catch {}
    }
  }

  invalidate(): void {
    try { this.tui?.requestRender?.(); } catch {}
  }
}

