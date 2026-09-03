// Minimal Component type mirroring the pi-tui contract used by ctx.ui.custom.
export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface Focusable {
  focused: boolean;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x1b\\/g, "").replace(/\x1b_pi:c\x07/g, "");
}

export function visibleWidth(s: string): number {
  const stripped = stripAnsi(s);
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
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
      if ((c >= "0" && c <= "9") || c === ";" || c === ":" || c === "?") { i++; continue; }
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

export function truncate(text: string, maxWidth: number, ellipsis = "..."): string {
  if (maxWidth <= 0) return "";
  const vw = visibleWidth(text);
  if (vw <= maxWidth) return text;
  const ellW = visibleWidth(ellipsis);
  const target = maxWidth - ellW;
  if (target <= 0) {
    let out = "";
    let w = 0;
    let i = 0;
    while (i < text.length) {
      const ansi = extractAnsiCode(text, i);
      if (ansi) { out += ansi.code; i += ansi.length; continue; }
      let grapheme = text[i];
      if (grapheme.charCodeAt(0) >= 0xD800 && grapheme.charCodeAt(0) <= 0xDBFF && i + 1 < text.length) {
        grapheme = text.slice(i, i + 2);
      }
      const gw = visibleWidth(grapheme);
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
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) { out += ansi.code; i += ansi.length; continue; }
    let grapheme = text[i];
    if (grapheme.charCodeAt(0) >= 0xD800 && grapheme.charCodeAt(0) <= 0xDBFF && i + 1 < text.length) {
      grapheme = text.slice(i, i + 2);
    }
    const gw = visibleWidth(grapheme);
    if (w + gw > target) break;
    out += grapheme;
    w += gw;
    i += grapheme.length;
  }
  out += ellipsis;
  return out;
}

/** Theme-safe styling helpers (fall back to plain text when theme is missing). */
export function fg(theme: unknown, color: string, text: string): string {
  try {
    const t = theme as { fg?: (c: string, s: string) => string };
    if (t && typeof t.fg === "function") return t.fg(color, text);
  } catch {}
  return text;
}

export function bold(theme: unknown, text: string): string {
  try {
    const t = theme as { bold?: (s: string) => string };
    if (t && typeof t.bold === "function") return t.bold(text);
  } catch {}
  return text;
}

export function highlight(theme: unknown, text: string): string {
  try {
    const t = theme as { bg?: (c: string, s: string) => string };
    if (t && typeof t.bg === "function") {
      try {
        const v = t.bg("selectedBg", text);
        if (v !== text) return v;
      } catch {}
      try {
        const v2 = t.bg("selection", text);
        if (v2 !== text) return v2;
      } catch {}
    }
  } catch {}
  try {
    const t = theme as { fg?: (c: string, s: string) => string };
    if (t && typeof t.fg === "function") return t.fg("accent", text);
  } catch {}
  return `› ${text}`;
}
