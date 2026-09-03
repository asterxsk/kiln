import type { Component, Focusable } from "./tui-helpers.js";
import { truncate, visibleWidth } from "./tui-helpers.js";

// Single-line text input (search query / new package name).
export class TextInput implements Component, Focusable {
  value = "";
  focused = false;
  private cursor = 0;

  getValue(): string { return this.value; }
  setValue(v: string): void { this.value = v; this.cursor = v.length; }

  handleInput(data: string): void {
    if (!data) return;
    if (data.includes("\x1b[200~")) {
      const start = data.indexOf("\x1b[200~");
      const end = data.indexOf("\x1b[201~");
      if (end !== -1) {
        const paste = data.substring(start + 6, end);
        this.value = this.value.slice(0, this.cursor) + paste + this.value.slice(this.cursor);
        this.cursor += paste.length;
        const remaining = data.slice(end + 6);
        if (remaining) this.handleInput(remaining);
        return;
      }
      data = data.replace("\x1b[200~", "");
    }
    if (data.includes("\x1b[201~")) data = data.replace("\x1b[201~", "");

    if (data === "\x7f" || data === "\x08" || data === "\b") {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor--;
      }
      return;
    }
    if (data === "\x1b[3~") {
      if (this.cursor < this.value.length) {
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      }
      return;
    }
    if (data === "\x1b[D" || data === "\x1bOD") { if (this.cursor > 0) this.cursor--; return; }
    if (data === "\x1b[C" || data === "\x1bOC") { if (this.cursor < this.value.length) this.cursor++; return; }
    if (data === "\x1b[H" || data === "\x1bOH" || data === "\x1b[1~") { this.cursor = 0; return; }
    if (data === "\x1b[F" || data === "\x1bOF" || data === "\x1b[4~") { this.cursor = this.value.length; return; }
    if (data === "\x15") { this.value = ""; this.cursor = 0; return; }
    if (data === "\x17") {
      if (this.cursor === 0) return;
      let pos = this.cursor;
      while (pos > 0 && this.value[pos - 1] === " ") pos--;
      while (pos > 0 && this.value[pos - 1] !== " ") pos--;
      this.value = this.value.slice(0, pos) + this.value.slice(this.cursor);
      this.cursor = pos;
      return;
    }
    if (data.startsWith("\x1b") && data.length > 1) return;
    if (data.length === 1 && data.charCodeAt(0) < 0x20) return;
    let insert = "";
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) insert += ch;
    }
    if (insert) {
      this.value = this.value.slice(0, this.cursor) + insert + this.value.slice(this.cursor);
      this.cursor += insert.length;
    }
  }

  render(width: number): string[] {
    const cursorMark = "\x1b_pi:c\x07";
    let display: string;
    if (this.focused) {
      const before = this.value.slice(0, this.cursor);
      const after = this.value.slice(this.cursor);
      display = before + cursorMark + (after.length > 0 ? after : " ");
      if (visibleWidth(display) > width) {
        const half = Math.floor(width / 2);
        const start = Math.max(0, this.cursor - half);
        const slice = this.value.slice(start, start + width);
        const curInSlice = this.cursor - start;
        display = slice.slice(0, curInSlice) + cursorMark + slice.slice(curInSlice);
      }
    } else {
      display = this.value;
    }
    return [truncate(display, width)];
  }

  invalidate(): void {}
}
