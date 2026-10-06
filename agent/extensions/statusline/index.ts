/**
 * Status Line — custom footer for pi
 *
 * Left:  {model name} {thinking} · {path}
 * Right: [auto compact in X% ]{percent}%/{window}
 *
 * Colors (all truecolor, sampled from the reference image — no theme colors):
 *  - model → orange  #E08A3C
 *  - thinking → gray  #C6C6C6
 *  - path → blue  #7AC0F5
 *  - auto-compact countdown → orange  #E08A3C
 *  - context text → yellow  #E5C04A
 *  - separators (·, spaces) → dim  #808080
 *
 * The "auto compact in X%" countdown appears only while context usage is within
 * 5% of pi's compaction threshold (contextWindow - compaction.reserveTokens).
 *
 * Example (Claude Opus 5.5 on high, 97% of 1M, ~/.pi):
 *   left:  Claude Opus 5.5 (9router combo) high · ~/.pi
 *   right: auto compact in 1% 97%/1M
 *
 * Visibility: shown in chat and in overlay views (e.g. the subagent interactive
 * takeover, which is a fullscreen overlay). Hidden during editor takeovers such
 * as /settings, /model, modelconf, or skillsconf — detected by tracking TUI
 * focus: every takeover moves focus away from the chat editor (and returns it
 * on close), while overlays keep hasOverlay() true.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// DEBUG: bump to confirm the loaded build; dumps raw render bytes to status-line-debug.log
const DEBUG_VERSION = 6;
const DEBUG_LOG = fileURLToPath(new URL("./status-line-debug.log", import.meta.url));
function debugLog(msg: string) {
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} v${DEBUG_VERSION} ${msg}\n`);
	} catch {}
}

// ---- helpers ----

function formatCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home) return cwd;
	// Normalize windows backslashes for comparison
	const normCwd = cwd.replace(/\\/g, "/");
	const normHome = home.replace(/\\/g, "/");
	if (normCwd === normHome) return "~";
	if (normCwd.startsWith(normHome + "/")) {
		return `~${normCwd.slice(normHome.length)}`;
	}
	return cwd;
}

function formatWindow(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		// Keep one decimal if not round, e.g. 1.1M; otherwise 1M
		if (Number.isInteger(m)) return `${m}M`;
		return `${m.toFixed(1)}M`;
	}
	if (n >= 1000) {
		const k = n / 1000;
		if (Number.isInteger(k)) return `${k}k`;
		return `${k.toFixed(1)}k`;
	}
	return String(n);
}

function formatContext(ctx: ExtensionContext): { text: string; percent: number | null; window: number | undefined } {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;

	if (!usage || usage.tokens === null || usage.percent === null || !window) {
		// Unknown tokens — show placeholder
		return { text: window ? `?%/${formatWindow(window)}` : "?%/??", percent: null, window };
	}

	const percent = Math.round(usage.percent);
	return { text: `${percent}%/${formatWindow(window)}`, percent, window };
}

function formatThinking(level: string | undefined): string {
	return level && level !== "off" ? level : "off";
}

// Mirrors pi's DEFAULT_COMPACTION_SETTINGS.reserveTokens (core/compaction).
const DEFAULT_COMPACTION_RESERVE = 16384;

// ---- takeover visibility ----
//
// Hide the footer when a full-screen takeover view is open (/settings, /model,
// modelconf, skillsconf, login, …) but keep it visible in chat and in overlay
// views (e.g. the subagent interactive takeover, which is a fullscreen overlay).
//
// Two signals, both fail-open (the footer stays visible unless we are sure a
// takeover is open):
// 1. Extension UI (ctx.ui.custom/select/input/confirm/editor) always emits
//    ui_prompt_start/end around the prompt. An active prompt without an overlay
//    means the editor was replaced by a takeover view.
// 2. Core takeovers (/settings, /model, login, reload notice) emit no events,
//    but they move TUI focus to a well-known component class, so match those
//    names. Inline widgets like autocomplete never move focus, so the footer
//    stays visible while completing.

// Matches core takeover views (all setFocus targets without ui_prompt
// events): SettingsSelectorComponent, ModelSelectorComponent,
// LoginDialogComponent, and the reload-notice Container.

const CORE_TAKEOVER_FOCUS = /(SelectorComponent|DialogComponent)$/;

function coreTakeoverName(tui: TUI): string | null {
	let focused: object | null = null;
	try {
		focused = (tui as unknown as { getFocusedComponent?: () => object | null }).getFocusedComponent?.() ?? null;
	} catch {
		return null;
	}
	if (!focused) return null;
	const name = (focused as { constructor?: { name?: string } }).constructor?.name ?? "?";
	if (name === "Container" || CORE_TAKEOVER_FOCUS.test(name)) return name;
	return null;
}

function hasVisibleOverlay(tui: TUI): boolean {
	try {
		return typeof tui.hasOverlay === "function" && tui.hasOverlay();
	} catch {
		return false;
	}
}

// ---- extension ----

export default function (pi: ExtensionAPI) {
	debugLog("extension factory loaded");
	let activeTui: TUI | undefined;
	let lastHideReason: string | null | undefined;
	// Active extension UI prompts (ctx.ui.custom/select/input/confirm/editor).
	// Any prompt without a visible overlay is an editor takeover.
	let uiPromptDepth = 0;

	pi.on("ui_prompt_start", () => {
		uiPromptDepth++;
		activeTui?.requestRender();
	});
	pi.on("ui_prompt_end", () => {
		uiPromptDepth = Math.max(0, uiPromptDepth - 1);
		activeTui?.requestRender();
	});
	// Re-render footer when model/thinking/tools change outside the normal render loop
	pi.on("model_select", () => activeTui?.requestRender());
	pi.on("thinking_level_select", () => activeTui?.requestRender());
	pi.on("tool_result", () => activeTui?.requestRender());
	pi.on("message_update", () => activeTui?.requestRender());
	// Session switches / compaction can change context window
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			// Keep cost/context fresh during streaming token updates
			// message_update fires per-token; requestRender is cheap & coalesced
			const unsubSession = (ctx as unknown as { sessionManager: { on?: (ev: string, fn: () => void) => () => void } }).sessionManager.on?.("update" as never, () => tui.requestRender());

			return {
				dispose() {
					try {
						unsubBranch();
					} catch {}
					if (typeof unsubSession === "function") {
						try {
							(unsubSession as () => void)();
						} catch {}
					}
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [""];
					// Overlay views (subagent takeover, pickers) keep the footer.
					let hideReason: string | null = null;
					if (!hasVisibleOverlay(tui)) {
						hideReason = uiPromptDepth > 0 ? "ui-prompt" : coreTakeoverName(tui);
					}
					if (hideReason !== lastHideReason) {
						lastHideReason = hideReason;
						debugLog(hideReason ? `hidden (${hideReason})` : "shown");
					}
					if (hideReason) return [""];
					const modelName = ctx.model?.name || ctx.model?.id || "no-model";
					const thinkingLevel = (pi.getThinkingLevel() as string | undefined) ?? (ctx.thinkingLevel as string | undefined) ?? "off";
					const thinkingText = formatThinking(thinkingLevel);
					const { text: ctxText, percent, window } = formatContext(ctx);
					const cwdStr = formatCwd(ctx.cwd);

					// Auto-compact countdown: appears within 5% of the compaction threshold
					const compaction = pi.getSettings().compaction;
					const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					const reserve = (modelKey ? compaction?.modelOverrides?.[modelKey]?.reserveTokens : undefined) ?? compaction?.reserveTokens ?? DEFAULT_COMPACTION_RESERVE;
					const remaining = percent !== null && window ? ((window - reserve) / window) * 100 - percent : null;
					const autoCompactText = (compaction?.enabled ?? true) && remaining !== null && remaining < 5 ? `auto compact in ${Math.max(0, Math.round(remaining))}%` : "";

					// --- plain strings for width math (no ANSI, so hyphens can't lose color in truncate/wrap) ---
					const leftPlain = `${modelName} ${thinkingText} · ${cwdStr}`;
					const rightPlain = `${autoCompactText ? `${autoCompactText} ` : ""}${ctxText}`;
					const leftW = visibleWidth(leftPlain);
					const rightW = visibleWidth(rightPlain);
					// Palette sampled from the reference image (truecolor, theme-independent)
					const tc = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
					const orange = tc(224, 138, 60);
					const yellow = tc(229, 192, 74);
					const gray = tc(198, 198, 198);
					const blue = tc(122, 192, 245);
					const dim = tc(128, 128, 128);
					const sep = dim(" · ");
					if (width === 1) return [dim("─")];

					const ctxColored = yellow(ctxText);
					const rightColored = (autoCompactText ? `${orange(autoCompactText)} ` : "") + ctxColored;

					// Build ANSI line only after width decisions
					if (leftW + 1 + rightW <= width) {
						const left = orange(modelName) + dim(" ") + gray(thinkingText) + sep + blue(cwdStr);
						const gap = " ".repeat(Math.max(1, width - leftW - rightW));
						return [left + gap + rightColored];
					}
					// Not enough width: truncate leftPlain first (keep right intact), then color the truncated pieces
					const maxLeft = Math.max(0, width - rightW - 1);
					let leftTruncPlain = leftPlain;
					if (leftPlain.length > maxLeft) {
						leftTruncPlain = maxLeft <= 3 ? leftPlain.slice(0, maxLeft) : leftPlain.slice(0, maxLeft - 3) + "...";
					}
					// Re-color truncated left: path tail is blue, the last " · " dim, model+thinking orange
					const sepIdx = leftTruncPlain.lastIndexOf(" · ");
					let left: string;
					if (sepIdx !== -1) {
						const head = leftTruncPlain.slice(0, sepIdx);
						const tail = leftTruncPlain.slice(sepIdx + 3);
						left = orange(head) + sep + blue(tail);
					} else {
						left = orange(leftTruncPlain);
					}
					let line = left + " " + rightColored;
					// Final safety: truncateToWidth handles ANSI correctly for the final line
					if (visibleWidth(line) > width) line = truncateToWidth(line, width);
					debugLog(`width=${width} line=${JSON.stringify(line)}`);
					return [line];
				},
			};
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Never leave a stale prompt count behind (would hide the footer forever).
		uiPromptDepth = 0;
		// Restore default footer when session tears down (avoid stale closure)
		try {
			if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		} catch {}
		activeTui = undefined;
	});

	// Streaming: request render for live context updates
	pi.on("agent_start", () => activeTui?.requestRender());
	pi.on("agent_settled", () => activeTui?.requestRender());
}
