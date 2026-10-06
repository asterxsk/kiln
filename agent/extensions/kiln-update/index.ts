/**
 * kiln-update — a minimal kiln header, plus a nudge when the checkout is behind GitHub.
 *
 * Replaces pi's built-in startup header with:
 *
 *   pi v1.0.4 kiln v0.4.0
 *   skills 23 extensions 14
 *
 * Press ctrl+o (the same key that expands tool output) to list every installed
 * skill and extension. When the installed `~/.pi/agent/version.txt` is behind
 * the one on `main`, the header also shows:
 *
 *   Update Available. To update, run:
 *   run npx @asterxsk/kiln@latest
 *
 * Failures (offline, timeout, missing file) are silent — this must never block
 * or annoy. Bump `agent/version.txt` with every user-visible change; no npm
 * publish is needed since `kiln` installs from GitHub.
 *
 * Env overrides:
 *   KILN_VERSION_URL        Full URL of the remote version.txt (for forks).
 *   KILN_NO_UPDATE_CHECK=1  Disable the check entirely.
 *   PI_AGENT_DIR            Local agent dir (default ~/.pi/agent).
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const REPO = "asterxsk/kiln";
const BRANCH = "main";
const TIMEOUT_MS = 5000;
const UPDATE_COMMAND = "npx @asterxsk/kiln@latest";

function remoteUrl(): string {
	return (
		process.env.KILN_VERSION_URL ||
		`https://raw.githubusercontent.com/${REPO}/${BRANCH}/agent/version.txt`
	);
}

function agentDir(): string {
	return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Installed version, or "" when unknown. */
export function localVersion(): string {
	try {
		return readFileSync(join(agentDir(), "version.txt"), "utf8").trim();
	} catch {
		// Fall through to the checkout-relative fallback.
	}
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return readFileSync(join(here, "..", "..", "version.txt"), "utf8").trim();
	} catch {
		return "";
	}
}

/** GitHub version, or "" when unreachable. Never throws. */
export async function remoteVersion(): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(remoteUrl(), { signal: ctrl.signal });
		if (!res.ok) return "";
		return (await res.text()).trim();
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

/** The update to report, or null when up to date / unknown / disabled. */
export async function checkForUpdate(): Promise<{ local: string; remote: string } | null> {
	if (process.env.KILN_NO_UPDATE_CHECK === "1") return null;
	const local = localVersion();
	if (!local) return null;
	const remote = await remoteVersion();
	if (!remote || remote === local) return null;
	return { local, remote };
}

/** Names of the installed skills or extensions, sorted. Never throws. */
function installedNames(kind: "skills" | "extensions"): string[] {
	try {
		return readdirSync(join(agentDir(), kind))
			.filter((name) => !name.startsWith("."))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

interface HeaderState {
	expanded: boolean;
	update: { local: string; remote: string } | null;
	kiln: string;
	skills: string[];
	extensions: string[];
}

function headerLines(state: HeaderState): string[] {
	const lines = [
		`pi v${VERSION} kiln v${state.kiln || "?"}`,
		`skills ${state.skills.length} extensions ${state.extensions.length}`,
	];
	if (state.expanded) {
		lines.push("");
		lines.push("Skills");
		for (const name of state.skills) lines.push(`  ${name}`);
		lines.push("Extensions");
		for (const name of state.extensions) lines.push(`  ${name}`);
	}
	if (state.update) {
		lines.push("Update Available. To update, run:");
		lines.push(`run ${UPDATE_COMMAND}`);
	}
	return lines;
}

function updateMessage(local: string, remote: string): string {
	return `Kiln update available (${local} → ${remote}) — to update, run: ${UPDATE_COMMAND}`;
}

export default function (pi: ExtensionAPI) {
	const state: HeaderState = {
		expanded: false,
		update: null,
		kiln: localVersion(),
		skills: [],
		extensions: [],
	};
	let requestRender: (() => void) | undefined;

	const refresh = () => {
		state.kiln = localVersion();
		state.skills = installedNames("skills");
		state.extensions = installedNames("extensions");
	};

	pi.on("session_start", async (_event, ctx) => {
		refresh();
		if (ctx.mode === "tui") {
			ctx.ui.setHeader((tui: TUI): Component & { setExpanded(expanded: boolean): void } => {
				requestRender = () => tui.requestRender();
				return {
					render: () => headerLines(state),
					invalidate: () => {},
					setExpanded: (expanded: boolean) => {
						state.expanded = expanded;
						tui.requestRender();
					},
				};
			});
		}
		state.update = await checkForUpdate();
		requestRender?.();
	});

	pi.registerCommand("kiln-update", {
		description: "Check whether kiln is behind the GitHub version",
		handler: async (_args, ctx) => {
			refresh();
			state.update = await checkForUpdate();
			requestRender?.();
			if (state.update) ctx.ui.notify(updateMessage(state.update.local, state.update.remote), "warning");
			else ctx.ui.notify("kiln is up to date", "info");
		},
	});
}
