/**
 * kiln-update — a minimal kiln header, plus a nudge when the checkout is behind GitHub.
 *
 * Replaces pi's built-in startup header with:
 *
 *    pi v1.0.4 kiln v0.4.0
 *    skills 23 extensions 14
 *    Press Ctrl-O to view more
 *
 * Every header line is indented by one space. A wrapped line below the counts
 * lists every functional extension slash command, joined by `·`; settings
 * menus (modelconf, skillsconf) are omitted. Press Ctrl-O (the same key that
 * expands tool output) to expand the header and list the loaded context files,
 * every installed skill, and every extension inline — a blank line above each
 * group, and long lists wrapped to the terminal width:
 *
 *    pi v1.0.4 kiln v0.4.0
 *    skills 23 extensions 14
 *
 *    [ctx]
 *    ~/.pi/agent/AGENTS.md, ~/AGENTS.md
 *
 *    [skills]
 *    alpha, beta
 *
 *    [extensions]
 *    extA, extB
 *
 * When the installed `~/.pi/agent/version.txt` is behind the one on `main`, the
 * header also shows:
 *
 *    Update Available. To update, run:
 *    run npx @asterxsk/kiln@latest
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseColor, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const REPO = "asterxsk/kiln";
const BRANCH = "main";
const TIMEOUT_MS = 5000;
const UPDATE_COMMAND = "npx @asterxsk/kiln@latest";
const CONTEXT_FILENAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const SETTINGS_COMMANDS = new Set(["modelconf", "skillsconf"]);
const PI_COLOR = parseColor("#5FD7D7");
const KILN_COLOR = parseColor("#FF8A80");
const GREY_COLOR = parseColor("#6E7681");

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

/** Context files pi loads: global first, then ancestors from root down to cwd. */
function contextFiles(cwd: string): string[] {
	const find = (dir: string): string | undefined =>
		CONTEXT_FILENAMES.map((name) => join(dir, name)).find((file) => existsSync(file));
	const seen = new Set<string>();
	const files: string[] = [];
	const global = find(agentDir());
	if (global) {
		files.push(global);
		seen.add(global);
	}
	const ancestors: string[] = [];
	let dir = cwd;
	while (true) {
		const file = find(dir);
		if (file && !seen.has(file)) {
			ancestors.unshift(file);
			seen.add(file);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	files.push(...ancestors);
	return files;
}

function displayPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

interface HeaderState {
	expanded: boolean;
	update: { local: string; remote: string } | null;
	kiln: string;
	context: string[];
	skills: string[];
	extensions: string[];
	commands: string[];
}

function headerLines(state: HeaderState, theme: Theme, width: number): string[] {
	const grey = (text: string) => theme.style(text, { fg: GREY_COLOR });
	const lines: string[] = [];
	const add = (line: string) => lines.push(` ${line}`);
	const addWrapped = (text: string) => {
		for (const segment of wrapTextWithAnsi(text, Math.max(1, width - 1))) add(segment);
	};
	const group = (label: string, items: string[]) => {
		if (items.length === 0) return;
		lines.push("");
		add(grey(label));
		addWrapped(grey(items.join(", ")));
	};

	add(
		`${theme.style("pi", { fg: PI_COLOR })} ${grey(`v${VERSION}`)} ${theme.style("kiln", {
			fg: KILN_COLOR,
		})} ${grey(`v${state.kiln || "?"}`)}`,
	);
	add(grey(`skills ${state.skills.length} extensions ${state.extensions.length}`));
	if (state.commands.length > 0) addWrapped(grey(state.commands.join(" · ")));
	if (state.expanded) {
		group("[ctx]", state.context.map(displayPath));
		group("[skills]", state.skills);
		group("[extensions]", state.extensions);
	} else {
		add(grey("Press Ctrl-O to view more"));
	}
	if (state.update) {
		lines.push("");
		add("Update Available. To update, run:");
		add(`run ${UPDATE_COMMAND}`);
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
		context: [],
		skills: [],
		extensions: [],
		commands: [],
	};
	let requestRender: (() => void) | undefined;

	const refresh = (cwd: string) => {
		state.kiln = localVersion();
		state.context = contextFiles(cwd);
		state.skills = installedNames("skills");
		state.extensions = installedNames("extensions");
		state.commands = pi
			.getCommands()
			.filter((command) => command.source === "extension" && !SETTINGS_COMMANDS.has(command.name))
			.map((command) => `/${command.name}`)
			.sort((a, b) => a.localeCompare(b));
	};

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx.cwd);
		if (ctx.mode === "tui") {
			ctx.ui.setHeader((tui: TUI, theme: Theme): Component & { setExpanded(expanded: boolean): void } => {
				requestRender = () => tui.requestRender();
				return {
					render: (width: number) => headerLines(state, theme, width),
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
			refresh(ctx.cwd);
			state.update = await checkForUpdate();
			requestRender?.();
			if (state.update) ctx.ui.notify(updateMessage(state.update.local, state.update.remote), "warning");
			else ctx.ui.notify("kiln is up to date", "info");
		},
	});
}
