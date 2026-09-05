/**
 * widget-order.ts — fixed stacking order for the above-editor widgets.
 *
 * Pi core renders above-editor widgets in Map insertion order: every
 * `setWidget` moves the key to the end (closest to the input). Since the
 * todo, background-terminal, and subagent widgets update independently, the
 * last updater would otherwise drift to the bottom. This helper keeps them
 * pinned top-to-bottom as:
 *
 *   1. todos (rpiv-todos, furthest from the input)
 *   2. background terminals
 *   3. subagents (closest to the input)
 *
 * How: a tiny registry on `globalThis` records the latest factory for each
 * managed key. Every set re-applies all visible managed widgets in canonical
 * order (clear the three keys, re-add the visible ones), so insertion order
 * — and therefore render order — is always canonical no matter which
 * extension updated last. Hiding a key just clears it; deletion never
 * disturbs the survivors' relative order, so no resync is needed there.
 *
 * NOTE: vendored copy. Identical logic lives in
 * `todo/widget-order.ts`, `background-terminals/src/widget-order.ts`, and
 * `subagents/src/widget-order.ts`. Extensions load in isolated jiti module
 * instances (no shared imports), but they share one Node process, so the
 * `globalThis` registry is the coordination channel. Keep the copies (and
 * WIDGET_ORDER) in sync.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Canonical top-to-bottom order above the editor. */
export const WIDGET_ORDER = ["rpiv-todos", "background-terminals", "subagents"] as const;

export type ManagedWidgetKey = (typeof WIDGET_ORDER)[number];

/** The ui surface the helper needs (the real ExtensionUIContext satisfies this). */
export type WidgetUI = Pick<ExtensionUIContext, "setWidget">;

type SetWidget = WidgetUI["setWidget"];
/** Factory form of setWidget content (the string[] form is unused here). */
export type WidgetFactory = Extract<Parameters<SetWidget>[1], (...args: never[]) => unknown>;
export type WidgetOptions = Parameters<SetWidget>[2];

interface RegistryEntry {
	content: WidgetFactory;
	options?: WidgetOptions;
}

declare global {
	// Shared across the isolated module instances of the three extensions
	// (same Node process, one TUI). See file header.
	// eslint-disable-next-line no-var
	var __kilnAboveEditorWidgetOrder: Map<string, RegistryEntry> | undefined;
}

function registry(): Map<string, RegistryEntry> {
	return (globalThis.__kilnAboveEditorWidgetOrder ??= new Map());
}

/**
 * Register (or refresh) a managed widget and restore canonical stacking.
 * Pass `undefined` content to hide (same as hideOrderedWidget).
 */
export function setOrderedWidget(
	ui: WidgetUI | undefined,
	key: ManagedWidgetKey,
	content: WidgetFactory | undefined,
	options?: WidgetOptions,
): void {
	if (!ui) return;
	if (content === undefined) {
		hideOrderedWidget(ui, key);
		return;
	}
	registry().set(key, { content, options });
	resync(ui);
}

/** Unregister a managed widget. No-op when it isn't registered. */
export function hideOrderedWidget(ui: WidgetUI | undefined, key: ManagedWidgetKey): void {
	if (!ui) return;
	const reg = registry();
	if (!reg.has(key)) {
		// Not tracked here, but pi may still hold it (e.g. registered before
		// this helper existed) — clear directly so we never leak a widget.
		try {
			ui.setWidget(key, undefined);
		} catch {
			// UI may be unavailable (print/RPC modes or teardown).
		}
		return;
	}
	reg.delete(key);
	try {
		ui.setWidget(key, undefined);
	} catch {
		// UI may be unavailable (print/RPC modes or teardown).
	}
}

/** Clear all managed keys, then re-add the visible ones in canonical order. */
function resync(ui: WidgetUI): void {
	const reg = registry();
	for (const key of WIDGET_ORDER) {
		try {
			ui.setWidget(key, undefined);
		} catch {
			// UI went away mid-sync — registry still holds the truth for next time.
			return;
		}
	}
	for (const key of WIDGET_ORDER) {
		const entry = reg.get(key);
		if (!entry) continue;
		try {
			ui.setWidget(key, entry.content, entry.options);
		} catch {
			return;
		}
	}
}
