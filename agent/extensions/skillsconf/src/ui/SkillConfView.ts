import {
  cloneState,
  normalizeMembers,
  statesEqual,
  toggleMembership,
  togglePackage,
} from "../persistence.js";
import type { SkillPackages, SkillState } from "../persistence.js";
import { deleteSkillFiles, resolveSkillDeleteTarget } from "../delete-skill.js";
import { fuzzyFilter } from "../fuzzy.js";
import { TextInput } from "./text-input.js";
import type { Component, Focusable } from "./tui-helpers.js";
import { bold, fg, highlight, stripAnsi, truncate, visibleWidth } from "./tui-helpers.js";

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
}

export interface SkillConfViewOpts {
  tui: any;
  theme: any;
  keybindings: any;
  skills: SkillInfo[];
  disabledRaw: string[] | undefined;
  packagesRaw: SkillPackages;
  onDone: (saved: boolean, discarded?: boolean) => void;
  onPersist: (disabled: string[] | undefined, packages: SkillPackages) => Promise<void>;
}

type Entry = { kind: "pkg"; name: string } | { kind: "skill"; name: string };

export class SkillConfView implements Component, Focusable {
  private tui: any;
  private theme: any;
  private keybindings: any;
  private onDone: (saved: boolean, discarded?: boolean) => void;
  private _onPersist: (disabled: string[] | undefined, packages: SkillPackages) => Promise<void>;

  private skills: SkillInfo[] = [];
  private skillNames: Set<string> = new Set();
  private draftDisabled: Set<string> = new Set();
  private draftPackages: Map<string, string[]> = new Map();
  private original: SkillState;

  private showPackages: boolean;
  private cursor = 0;

  private searchActive = false;
  private searchQuery = "";
  private searchInput = new TextInput();

  private naming = false;
  private nameInput = new TextInput();

  private assignTarget: string | null = null;
  private assignSnapshot: string[] | null = null;

  private pendingDelete: { kind: "pkg" | "skill"; name: string; target: string } | null = null;

  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(v: boolean) {
    this._focused = v;
    this.searchInput.focused = v && this.searchActive;
    this.nameInput.focused = v && this.naming;
  }

  constructor(opts: SkillConfViewOpts) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.keybindings = opts.keybindings;
    this.onDone = opts.onDone;
    this._onPersist = opts.onPersist;

    this.skills = [...(opts.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    this.skillNames = new Set(this.skills.map((s) => s.name));
    for (const n of opts.disabledRaw ?? []) {
      if (this.skillNames.has(n)) this.draftDisabled.add(n);
    }
    const pkgs = opts.packagesRaw ?? {};
    for (const k of Object.keys(pkgs)) {
      // Stale members (skills no longer on disk) are dropped from the draft;
      // save filters them too, so the next save cleans settings.
      this.draftPackages.set(k, normalizeMembers((pkgs[k] ?? []).filter((m) => this.skillNames.has(m))));
    }
    this.original = this.snapshot();
    this.showPackages = this.draftPackages.size > 0;
    this.cursor = 0;
  }

  // ---------- draft state ----------

  private snapshot(): SkillState {
    const packages: SkillPackages = {};
    for (const [k, v] of this.draftPackages) packages[k] = [...v];
    const disabled = this.draftDisabled.size === 0 ? undefined : [...this.draftDisabled].sort();
    return { disabled, packages };
  }

  private isDirty(): boolean {
    return !statesEqual(this.original, this.snapshot());
  }

  private knownMembers(pkg: string): string[] {
    return (this.draftPackages.get(pkg) ?? []).filter((m) => this.skillNames.has(m));
  }

  /** Names of packages containing the skill. */
  private packagesOf(name: string): string[] {
    const out: string[] = [];
    for (const [pkg, members] of this.draftPackages) {
      if (members.includes(name)) out.push(pkg);
    }
    return out;
  }

  private inAnyPackage(name: string): boolean {
    for (const members of this.draftPackages.values()) {
      if (members.includes(name)) return true;
    }
    return false;
  }

  private ungroupedCount(): number {
    let n = 0;
    for (const s of this.skills) if (!this.inAnyPackage(s.name)) n++;
    return n;
  }

  private pkgEnabledCount(pkg: string): { enabled: number; total: number } {
    const members = this.knownMembers(pkg);
    let enabled = 0;
    for (const m of members) if (!this.draftDisabled.has(m)) enabled++;
    return { enabled, total: members.length };
  }

  private enabledCount(): number {
    let n = 0;
    for (const s of this.skills) if (!this.draftDisabled.has(s.name)) n++;
    return n;
  }

  // ---------- entries ----------

  private filteredSkills(): SkillInfo[] {
    if (!this.searchQuery.trim()) return this.skills;
    try {
      return fuzzyFilter(this.searchQuery, this.skills, (s) => `${s.name} ${s.description}`);
    } catch {
      return [];
    }
  }

  private entries(): Entry[] {
    const out: Entry[] = [];
    const filtering = this.searchQuery.trim().length > 0;
    // Grouped view: skills that live in a package are hidden from the main
    // list (managed via their package row). Flat otherwise: packages hidden,
    // filtering, or assigning (needs every skill visible).
    const grouped = !this.assignTarget && !filtering && this.showPackages && this.draftPackages.size > 0;
    if (!this.assignTarget && !filtering && this.showPackages) {
      for (const name of this.draftPackages.keys()) out.push({ kind: "pkg", name });
    }
    const list = filtering ? this.filteredSkills() : this.skills;
    for (const s of list) {
      if (grouped && this.inAnyPackage(s.name)) continue;
      out.push({ kind: "skill", name: s.name });
    }
    return out;
  }

  private clampCursor(): void {
    const len = this.entries().length;
    if (len === 0) this.cursor = -1;
    else if (this.cursor < 0 || this.cursor >= len) this.cursor = Math.max(0, Math.min(this.cursor, len - 1));
  }

  private skillByName(name: string): SkillInfo | undefined {
    return this.skills.find((s) => s.name === name);
  }

  private setNotice(msg: string | null): void {
    this.notice = msg;
    if (this.noticeTimer) { try { clearTimeout(this.noticeTimer); } catch {} this.noticeTimer = null; }
    if (msg) {
      this.noticeTimer = setTimeout(() => {
        this.notice = null;
        try { this.tui?.requestRender?.(); } catch {}
      }, 4000) as unknown as ReturnType<typeof setTimeout>;
      try {
        (this.noticeTimer as unknown as { unref?: () => void }).unref?.();
      } catch {}
    }
  }

  private requestRender(): void {
    try { this.tui?.requestRender?.(); } catch {}
  }

  // ---------- actions ----------

  private toggleEntry(entry: Entry): void {
    if (entry.kind === "skill") {
      if (this.assignTarget) {
        const members = this.draftPackages.get(this.assignTarget) ?? [];
        this.draftPackages.set(this.assignTarget, toggleMembership(members, entry.name));
      } else {
        if (this.draftDisabled.has(entry.name)) this.draftDisabled.delete(entry.name);
        else this.draftDisabled.add(entry.name);
      }
      return;
    }
    // package: mass disable/enable known members
    const members = this.knownMembers(entry.name);
    if (members.length === 0) {
      this.setNotice(`"${entry.name}" is empty — press a to add skills`);
      return;
    }
    const next = togglePackage(members, [...this.draftDisabled]);
    this.draftDisabled = new Set(next ?? []);
  }

  private startAssign(pkg: string): void {
    this.assignTarget = pkg;
    this.assignSnapshot = [...(this.draftPackages.get(pkg) ?? [])];
    this.setNotice(`assigning to "${pkg}" — Space toggles, Enter done, Esc cancel`);
    // Move cursor to the first skill entry.
    const list = this.entries();
    const idx = list.findIndex((e) => e.kind === "skill");
    this.cursor = idx === -1 ? -1 : idx;
  }

  private confirmAssign(): void {
    if (!this.assignTarget) return;
    const members = this.knownMembers(this.assignTarget);
    this.assignTarget = null;
    this.assignSnapshot = null;
    this.setNotice(`package updated (${members.length} skills)`);
    this.clampCursor();
  }

  private cancelAssign(): void {
    if (this.assignTarget && this.assignSnapshot) {
      this.draftPackages.set(this.assignTarget, this.assignSnapshot);
    }
    this.assignTarget = null;
    this.assignSnapshot = null;
    this.setNotice("assign cancelled");
    this.clampCursor();
  }

  private executeDelete(del: { kind: "pkg" | "skill"; name: string; target: string }): Promise<void> {
    if (del.kind === "pkg") {
      this.draftPackages.delete(del.name);
      if (this.assignTarget === del.name) {
        this.assignTarget = null;
        this.assignSnapshot = null;
      }
      this.setNotice(`deleted package "${del.name}"`);
      this.clampCursor();
      this.requestRender();
      return Promise.resolve();
    }
    const filePath = this.skillByName(del.name)?.filePath ?? "";
    return deleteSkillFiles(filePath).then(
      (target) => {
        this.skills = this.skills.filter((s) => s.name !== del.name);
        this.skillNames.delete(del.name);
        this.draftDisabled.delete(del.name);
        for (const [k, members] of this.draftPackages) {
          if (members.includes(del.name)) {
            this.draftPackages.set(k, members.filter((m) => m !== del.name));
          }
        }
        this.setNotice(`deleted skill "${del.name}" (${target})`);
        this.clampCursor();
        this.requestRender();
      },
      (err) => {
        this.setNotice(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
        this.requestRender();
      },
    );
  }

  /** Persist the draft in place; the UI stays open. */
  private saveDraft(): void {
    if (!this.isDirty()) {
      this.setNotice("nothing to save");
      this.requestRender();
      return;
    }
    const snap = this.snapshot();
    Promise.resolve(this._onPersist(snap.disabled, snap.packages)).then(() => {
      this.original = cloneState(snap);
      const np = this.draftPackages.size;
      this.setNotice(
        `saved — ${this.enabledCount()}/${this.skills.length} enabled, ${np} package${np === 1 ? "" : "s"}`,
      );
      this.requestRender();
    }).catch(() => {
      this.setNotice("save failed — see console");
      this.requestRender();
    });
  }

  private confirmNewPackage(): void {
    const name = this.nameInput.getValue().trim();
    if (!name) {
      this.setNotice("package name is empty");
      return;
    }
    const exists = [...this.draftPackages.keys()].some((k) => k.toLowerCase() === name.toLowerCase());
    if (exists) {
      this.setNotice(`"${name}" already exists`);
      return;
    }
    this.draftPackages.set(name, []);
    this.naming = false;
    this.nameInput.setValue("");
    this.nameInput.focused = false;
    this.showPackages = true;
    this.searchQuery = "";
    this.searchInput.setValue("");
    this.searchActive = false;
    // Jump cursor to the new package.
    const list = this.entries();
    const idx = list.findIndex((e) => e.kind === "pkg" && e.name === name);
    this.cursor = idx === -1 ? 0 : idx;
    this.setNotice(`created "${name}" — press a on it to add skills`);
  }

  private clearFilter(): void {
    this.searchActive = false;
    this.searchInput.focused = false;
    this.searchInput.setValue("");
    this.searchQuery = "";
    this.clampCursor();
  }

  // ---------- render ----------

  private getAvailableHeight(): number {
    let h: number | undefined;
    try {
      const term = (this.tui as unknown as { terminal?: unknown })?.terminal as
        | { rows?: number; height?: number; getSize?: () => { rows?: number } }
        | undefined;
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
        const c = (globalThis as { process?: { stdout?: { rows?: number } } }).process?.stdout;
        if (c && typeof c.rows === "number") h = c.rows;
      } catch {}
    }
    if (h === undefined || h === null || h <= 0) h = 24;
    const extra = (this.searchActive ? 1 : 0) + (this.assignTarget ? 1 : 0) + (this.naming ? 1 : 0);
    const half = Math.floor(h / 2);
    const chrome = 9 + extra;
    return Math.min(Math.max(5, half - chrome), 20);
  }

  /** Package row: accent marker + bold name, no box drawing. */
  private packageRow(name: string): string {
    const { enabled: en, total: tot } = this.pkgEnabledCount(name);
    const mark = tot === 0
      ? fg(this.theme, "dim", "○")
      : en === tot
        ? fg(this.theme, "success", "◉")
        : en === 0
          ? fg(this.theme, "dim", "○")
          : fg(this.theme, "warning", "◍");
    const count = tot === 0
      ? fg(this.theme, "dim", "(empty)")
      : fg(this.theme, "dim", `(${en}/${tot})`);
    const assigning = this.assignTarget === name ? fg(this.theme, "accent", "  [assigning]") : "";
    const marker = fg(this.theme, "accent", "▸");
    const label = fg(this.theme, "accent", bold(this.theme, name));
    return `${marker} ${mark} ${label} ${count}${assigning}`;
  }

  /** Boxed input for the new-package name so the typing affordance is obvious. */
  private nameBox(width: number): string[] {
    const boxW = Math.max(24, Math.min(44, width - 2));
    const inner = boxW - 4;
    const value = this.nameInput.render(inner)[0] ?? "";
    const pad = Math.max(0, inner - visibleWidth(value));
    const title = " new package name ";
    const top =
      fg(this.theme, "accent", "┌─") +
      fg(this.theme, "accent", bold(this.theme, title)) +
      fg(this.theme, "accent", "─".repeat(Math.max(0, boxW - 3 - title.length)) + "┐");
    const mid = fg(this.theme, "accent", "│ ") + value + " ".repeat(pad) + fg(this.theme, "accent", " │");
    const bottom = fg(this.theme, "accent", "└" + "─".repeat(boxW - 2) + "┘");
    return [top, mid, bottom];
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const total = this.skills.length;
    const enabled = this.enabledCount();
    const np = this.draftPackages.size;
    const dirtyMark = this.isDirty() ? fg(this.theme, "warning", "  ● unsaved") : "";
    lines.push(truncate(
      fg(this.theme, "accent", bold(this.theme, "skillsconf")) +
      fg(this.theme, "dim", `  ${enabled}/${total} enabled  ${np} package${np === 1 ? "" : "s"}`) + dirtyMark,
      width,
    ));
    lines.push(truncate(fg(this.theme, "dim", "─".repeat(Math.max(0, width))), width));

    if (this.assignTarget) {
      lines.push(truncate(
        fg(this.theme, "warning", ` assigning → "${this.assignTarget}"`) +
        fg(this.theme, "dim", "  Space toggles membership  •  Enter done  •  Esc cancel"),
        width,
      ));
    }
    if (this.naming) {
      for (const bl of this.nameBox(width)) lines.push(truncate(bl, width));
    } else if (this.searchActive) {
      const inputWidth = Math.max(10, width - 4);
      const rendered = this.searchInput.render(inputWidth);
      lines.push(truncate(fg(this.theme, "accent", "/ ") + (rendered[0] ?? ""), width));
    } else if (this.searchQuery) {
      lines.push(truncate(
        fg(this.theme, "dim", `filter: "${this.searchQuery}" (${this.entries().length}/${total})  •  Esc to clear  •  / to search`),
        width,
      ));
    }

    const list = this.entries();
    if (list.length === 0) {
      if (this.searchQuery) {
        lines.push(truncate(fg(this.theme, "warning", `  No skills match '${this.searchQuery}'`), width));
        lines.push(truncate(fg(this.theme, "dim", "  Press Esc to clear filter"), width));
      } else {
        lines.push(truncate(fg(this.theme, "dim", "  No skills loaded"), width));
      }
    } else {
      const maxVisible = this.getAvailableHeight();
      let start = 0;
      let end = list.length;
      if (list.length > maxVisible) {
        const half = Math.floor(maxVisible / 2);
        start = Math.max(0, Math.min(this.cursor - half, list.length - maxVisible));
        end = Math.min(start + maxVisible, list.length);
      }
      const grouped = !this.searchQuery && !this.assignTarget && this.showPackages && this.draftPackages.size > 0;
      let lastKind: Entry["kind"] | "" = "";
      for (let idx = start; idx < end; idx++) {
        const entry = list[idx];
        if (!this.searchQuery && !this.assignTarget && entry.kind !== lastKind) {
          lastKind = entry.kind;
          if (entry.kind === "pkg") {
            lines.push(truncate(
              fg(this.theme, "accent", bold(this.theme, ` PACKAGES (${this.draftPackages.size}) `)) +
              fg(this.theme, "dim", " Space toggles whole group"),
              width,
            ));
          } else {
            const label = grouped
              ? ` UNGROUPED SKILLS (${this.ungroupedCount()}) `
              : ` SKILLS (${total}) `;
            lines.push(truncate(fg(this.theme, "accent", bold(this.theme, label)), width));
          }
        }
        const isCursor = this.cursor === idx;
        let line: string;
        if (entry.kind === "pkg") {
          line = this.packageRow(entry.name);
        } else {
          const info = this.skillByName(entry.name);
          const showTags = !!this.assignTarget || this.searchQuery.trim().length > 0;
          const tags = showTags ? this.packagesOf(entry.name) : [];
          const tagText = tags.length > 0 ? fg(this.theme, "dim", ` ⟨${tags.join(",")}⟩`) : "";
          if (this.assignTarget) {
            const member = (this.draftPackages.get(this.assignTarget) ?? []).includes(entry.name);
            const mark = member ? fg(this.theme, "success", "+") : fg(this.theme, "dim", "·");
            const desc = info?.description ? fg(this.theme, "dim", ` ${info.description}`) : "";
            line = `  ${mark} ${entry.name}${desc}${tagText}`;
          } else {
            const on = !this.draftDisabled.has(entry.name);
            const mark = on ? fg(this.theme, "success", "◉") : fg(this.theme, "dim", "○");
            const desc = info?.description ? fg(this.theme, "dim", ` ${info.description}`) : "";
            line = `  ${mark} ${entry.name}${desc}${tagText}`;
          }
        }
        lines.push(truncate(isCursor ? highlight(this.theme, line) : line, width));
      }
      if (list.length > maxVisible) {
        const pos = this.cursor >= 0 ? this.cursor + 1 : 0;
        lines.push(truncate(fg(this.theme, "dim", `  (${pos}/${list.length})`), width));
      }
    }

    lines.push("");
    if (this.pendingDelete) {
      const del = this.pendingDelete;
      const msg = del.kind === "pkg"
        ? `Delete package "${del.name}"? (members keep their on/off state)  y delete  n cancel`
        : `Delete skill "${del.name}" from disk?  ${del.target}  y delete  n cancel`;
      lines.push(truncate(fg(this.theme, "warning", msg), width));
    } else if (this.notice) {
      lines.push(truncate(fg(this.theme, "accent", this.notice), width));
    } else if (this.isDirty()) {
      lines.push(truncate(fg(this.theme, "warning", "● unsaved — press s to save"), width));
    } else if (this.searchActive) {
      lines.push(truncate(fg(this.theme, "dim", "filtering — ↑↓ exit typing  •  ←→ edit  •  Esc clear  •  Enter keep"), width));
    } else if (this.naming) {
      lines.push(truncate(fg(this.theme, "dim", "Enter create  •  Esc cancel"), width));
    } else if (this.assignTarget) {
      lines.push(truncate(fg(this.theme, "dim", `${this.knownMembers(this.assignTarget).length} in package`), width));
    } else {
      lines.push(truncate(fg(this.theme, "dim", `${enabled} enabled / ${total} total`), width));
    }

    const kb = this.assignTarget
      ? ["Space toggle membership │ Enter done │ Esc cancel"]
      : this.naming
        ? ["type a name │ Enter create │ Esc cancel"]
        : [
            "↑↓/j k navigate │ Space toggle │ / filter │ e flat/grouped view",
            "n new package │ a add skills to package │ d delete │ s save │ Esc close",
          ];
    for (const row of kb) {
      const oneLine = fg(this.theme, "dim", row);
      try {
        if (visibleWidth(stripAnsi(oneLine)) + 2 <= width) lines.push(truncate(oneLine, width));
        else lines.push(truncate(oneLine, width));
      } catch {
        lines.push(truncate(oneLine, width));
      }
    }
    return lines.map((l) => truncate(l, width));
  }

  // ---------- input ----------

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
    const isEsc = data === "\x1b" || tryKb("escape") || data.includes("\x1b[27");
    // Bare Enter only: pasted text containing newlines must not confirm/save.
    const isEnter = data === "\r" || data === "\n" || data === "\r\n" || tryKb("enter") || tryKb("return");
    const isQ = data === "q" || data === "Q";

    // --- naming mode captures everything except Enter/Esc ---
    if (this.naming) {
      if (isEnter) { this.confirmNewPackage(); this.requestRender(); return; }
      if (isEsc) {
        this.naming = false;
        this.nameInput.setValue("");
        this.nameInput.focused = false;
        this.requestRender();
        return;
      }
      try { this.nameInput.handleInput?.(data); } catch {}
      this.requestRender();
      return;
    }

    // --- pending delete captures everything except y/n/Esc ---
    if (this.pendingDelete) {
      if (data === "y" || data === "Y") {
        const del = this.pendingDelete;
        this.pendingDelete = null;
        void this.executeDelete(del);
        return;
      }
      if (data === "n" || data === "N" || isEsc || isQ) {
        this.pendingDelete = null;
        this.setNotice("delete cancelled");
        this.requestRender();
        return;
      }
      return;
    }

    // --- search mode ---
    if (!this.searchActive && data === "/") {
      this.searchActive = true;
      this.searchInput.focused = true;
      this._focused = true;
      this.searchInput.setValue("");
      this.searchQuery = "";
      if (!this.assignTarget) this.cursor = this.entries().length > 0 ? 0 : -1;
      this.requestRender();
      return;
    }
    if (this.searchActive) {
      // Up/down leave search typing and return to normal mode with the
      // filter kept (like Enter). Left/right stay in search editing the query.
      const arrowUp = data === "\x1b[A" || data === "\x1bOA" || tryKb("up");
      const arrowDown = data === "\x1b[B" || data === "\x1bOB" || tryKb("down");
      if (arrowUp || arrowDown) {
        this.searchActive = false;
        this.searchInput.focused = false;
        const len = this.entries().length;
        if (len > 0) {
          if (arrowUp) this.cursor = (this.cursor - 1 + len) % len;
          else this.cursor = (this.cursor + 1) % len;
        }
        this.requestRender();
        return;
      }
      const navHome = data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH" || tryKb("home");
      const navEnd = data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF" || tryKb("end");
      if (navHome || navEnd) {
        const len = this.entries().length;
        if (len > 0) {
          if (navHome) this.cursor = 0;
          else this.cursor = len - 1;
        }
        this.requestRender();
        return;
      }
      if (isEsc) { this.clearFilter(); this.requestRender(); return; }
      if (isEnter) {
        this.searchActive = false;
        this.searchInput.focused = false;
        this.requestRender();
        return;
      }
      if (data === "\t" || data === "\x1b[Z") { this.requestRender(); return; }
      try { this.searchInput.handleInput?.(data); } catch {}
      this.searchQuery = this.searchInput.getValue();
      this.cursor = this.entries().length > 0 ? 0 : -1;
      this.requestRender();
      return;
    }

    // --- normal / assign keys ---
    if (!this.assignTarget && (data === "e" || data === "E")) {
      this.showPackages = !this.showPackages;
      this.clampCursor();
      this.requestRender();
      return;
    }
    if (!this.assignTarget && (data === "n" || data === "N")) {
      this.naming = true;
      this.nameInput.setValue("");
      this.nameInput.focused = true;
      this._focused = true;
      this.requestRender();
      return;
    }
    if (data === "a" || data === "A") {
      if (this.assignTarget) {
        this.setNotice("already assigning — Enter done, Esc cancel");
        this.requestRender();
        return;
      }
      const cur = this.entries()[this.cursor];
      if (cur && cur.kind === "pkg") {
        this.startAssign(cur.name);
        this.requestRender();
        return;
      }
      this.setNotice("put the cursor on a package and press a");
      this.requestRender();
      return;
    }
    if (data === "d" || data === "D") {
      const cur = this.entries()[this.cursor];
      if (!cur) return;
      if (cur.kind === "pkg") {
        this.pendingDelete = { kind: "pkg", name: cur.name, target: "" };
      } else {
        const info = this.skillByName(cur.name);
        const target = info ? resolveSkillDeleteTarget(info.filePath) : null;
        if (!target) {
          this.setNotice(`cannot delete "${cur.name}": unknown location`);
          this.requestRender();
          return;
        }
        this.pendingDelete = { kind: "skill", name: cur.name, target };
      }
      this.requestRender();
      return;
    }
    if ((isEsc || isQ) && this.searchQuery) {
      this.clearFilter();
      this.requestRender();
      return;
    }
    if (this.assignTarget && isEsc) {
      this.cancelAssign();
      this.requestRender();
      return;
    }
    if (isEsc || isQ) {
      const dirty = this.isDirty();
      this.onDone(false, dirty);
      return;
    }
    if (data === " ") {
      const cur = this.entries()[this.cursor];
      if (!cur) return;
      this.toggleEntry(cur);
      this.clampCursor();
      this.requestRender();
      return;
    }
    if (!this.assignTarget && (data === "s" || data === "S")) {
      this.saveDraft();
      return;
    }
    if (isEnter) {
      if (this.assignTarget) {
        this.confirmAssign();
        this.requestRender();
      }
      // Bare Enter never saves — use s.
      return;
    }
    let handled = false;
    const isUp = data === "k" || data === "\x1b[A" || data === "\x1bOA" || tryKb("up") || tryKb("k");
    const isDown = data === "j" || data === "\x1b[B" || data === "\x1bOB" || tryKb("down") || tryKb("j");
    const isHome = data === "g" || data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH" || tryKb("home") || tryKb("g");
    const isEnd = data === "G" || data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF" || tryKb("end") || tryKb("G");
    const len = this.entries().length;
    if (isUp) {
      if (len > 0) { this.cursor = (this.cursor - 1 + len) % len; handled = true; }
    } else if (isDown) {
      if (len > 0) { this.cursor = (this.cursor + 1) % len; handled = true; }
    } else if (isHome) {
      if (len > 0) { this.cursor = 0; handled = true; }
    } else if (isEnd) {
      if (len > 0) { this.cursor = len - 1; handled = true; }
    }
    if (handled) this.requestRender();
  }

  invalidate(): void {
    this.requestRender();
  }
}
