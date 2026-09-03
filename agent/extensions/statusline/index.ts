/**
 * Status Line — custom footer for pi
 *
 * Left:  provider/model using {thinking} effort • {percent}%/{window}
 * Right: $cost • path
 *
 * Colors:
 *  - model / thinking / cost → white (theme "text")
 *  - path → blue (theme "accent")
 *  - context → white under 262k tokens, red over 262k
 *  - separators (•, spaces) → dim
 *
 * Example (Muse Spark 1.2 contributor on high, 1% of 1M, $0.002, ~/.pi):
 *   left:  opencode-go/muse-spark-1.2-contributer using high effort • 1%/1M
 *   right: $0.002 • ~/.pi
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
const DEBUG_VERSION = 5;
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

function formatContext(ctx: ExtensionContext): { text: string; over: boolean } {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;

	if (!usage || usage.tokens === null || usage.percent === null || !window) {
		// Unknown tokens — show placeholder but never red
		return { text: window ? `?%/${formatWindow(window)}` : "?%/??", over: false };
	}

	const percent = Math.round(usage.percent);
	const over = usage.tokens > 262_000;
	return { text: `${percent}%/${formatWindow(window)}`, over };
}

function formatThinking(level: string | undefined): string {
	if (!level || level === "off") return "off";
	return `using ${level} effort`;
}

function computeCost(ctx: ExtensionContext): number {
	let total = 0;
	try {
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && (e as unknown as { message?: { role?: string; usage?: { cost?: { total?: number } } } }).message?.role === "assistant") {
				const usage = (e as unknown as { message: { usage?: { cost?: { total?: number } } } }).message.usage;
				if (usage?.cost?.total) total += usage.cost.total;
			}
		}
	} catch {
		// ignore
	}
	return total;
}

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
					const modelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
					const thinkingLevel = (pi.getThinkingLevel() as string | undefined) ?? (ctx.thinkingLevel as string | undefined) ?? "off";
					const thinkingText = formatThinking(thinkingLevel);
					const { text: ctxText, over } = formatContext(ctx);
					const cost = computeCost(ctx);
					const costStr = `$${cost.toFixed(3)}`;
					const cwdStr = formatCwd(ctx.cwd);

					// --- plain strings for width math (no ANSI, so hyphens can't lose color in truncate/wrap) ---
					const leftPlain = `${modelId} ${thinkingText} • ${ctxText}`;
					const rightPlain = `${costStr} • ${cwdStr}`;
					const leftW = leftPlain.length; // all ascii, visibleWidth == length
					const rightW = rightPlain.length;
					if (width === 1) return [theme.fg("dim", "─")];

					// Colors — force true white (#FFFFFF) so "-" never falls back to dim grey
					const W_OPEN = "\x1b[38;2;255;255;255m";
					const W_CLOSE = "\x1b[39m";
					const white = (s: string) => `${W_OPEN}${s}${W_CLOSE}`;
					const blue = (s: string) => theme.fg("accent", s);
					const dim = (s: string) => theme.fg("dim", s);
					const red = (s: string) => theme.fg("error", s);
					const sepPlain = " • ";
					const sep = dim(sepPlain);

					// Build ANSI line only after width decisions
					let left: string;
					let right: string;
					const gapPlain = Math.max(1, width - leftW - rightW);
					if (leftW + 1 + rightW <= width) {
						left = white(modelId) + dim(" ") + white(thinkingText) + sep + (over ? red(ctxText) : white(ctxText));
						right = white(costStr) + sep + blue(cwdStr);
						const gap = " ".repeat(gapPlain);
						return [left + gap + right];
					}
					// Not enough width: truncate leftPlain first (keep right intact), then color the truncated pieces
					const maxLeft = Math.max(0, width - rightW - 1);
					let leftTruncPlain = leftPlain;
					if (leftPlain.length > maxLeft) {
						leftTruncPlain = maxLeft <= 3 ? leftPlain.slice(0, maxLeft) : leftPlain.slice(0, maxLeft - 3) + "...";
					}
					// Re-derive left parts from truncated plain (approx: truncate from the end)
					// Simpler: color the whole truncated left as white, but keep "•" dim and ctx red/white tail
					// Find where " • " sits in leftPlain
					const sepIdx = leftPlain.lastIndexOf(sepPlain);
					if (sepIdx !== -1 && leftTruncPlain.length > sepIdx) {
						const head = leftTruncPlain.slice(0, sepIdx);
						const tail = leftTruncPlain.slice(sepIdx + sepPlain.length);
						left = white(head) + sep + (over ? red(tail) : white(tail));
					} else {
						left = white(leftTruncPlain);
					}
					right = white(costStr) + sep + blue(cwdStr);
					let line = left + " " + right;
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

	// Streaming: request render for live cost/context updates
	pi.on("agent_start", () => activeTui?.requestRender());
	pi.on("agent_settled", () => activeTui?.requestRender());
}
