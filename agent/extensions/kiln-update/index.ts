/**
 * kiln-update — tell the user when their kiln checkout is behind GitHub.
 *
 * Compares the installed `~/.pi/agent/version.txt` against the one on the
 * main branch. On mismatch, shows a nudge on every session start:
 *
 *   Kiln update available (0.2.0 → 0.3.0) — to update kiln to the newest
 *   version, run: kiln
 *
 * Failures (offline, timeout, missing file) are silent — this must never
 * block or annoy. Bump `agent/version.txt` with every user-visible change;
 * no npm publish is needed since `kiln` installs from GitHub.
 *
 * Env overrides:
 *   KILN_VERSION_URL     Full URL of the remote version.txt (for forks).
 *   KILN_NO_UPDATE_CHECK=1  Disable the check entirely.
 *   PI_AGENT_DIR         Local agent dir (default ~/.pi/agent).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REPO = "asterxsk/kiln";
const BRANCH = "main";
const TIMEOUT_MS = 5000;

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

function updateMessage(local: string, remote: string): string {
	return `Kiln update available (${local} → ${remote}) — to update kiln to the newest version, run: kiln`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const update = await checkForUpdate();
		if (update) ctx.ui.notify(updateMessage(update.local, update.remote), "warning");
	});

	pi.registerCommand("kiln-update", {
		description: "Check whether kiln is behind the GitHub version",
		handler: async (_args, ctx) => {
			const update = await checkForUpdate();
			if (update) ctx.ui.notify(updateMessage(update.local, update.remote), "warning");
			else ctx.ui.notify("kiln is up to date", "info");
		},
	});
}
