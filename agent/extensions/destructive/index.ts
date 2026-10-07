/**
 * destructive - Asks before running destructive (deletion) commands.
 *
 * Intercepts `bash` / `powershell` tool calls and prompts:
 *
 *   Do you want to allow pi to run:
 *   {destructive segment(s) only}
 *
 *   1. Allow
 *   2. Deny
 *
 * Only the destructive segment(s) of a compound command are shown, so a long
 * multi-line shell script collapses to just the `rm`/`git` line that triggered
 * the guard.
 *
 * Anything else (including Deny, or dismissing with Esc) blocks the command.
 * In non-interactive mode (no UI) deletion commands are blocked by default.
 *
 * Run `/destructive` to toggle the guard on or off for the current session.
 * It defaults to on and resets to on when pi restarts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_DELETERS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
]);

function isDestructiveGit(rest: string): boolean {
  const args = rest.trim();
  if (/^rm\b/.test(args)) return true;
  if (/^branch\b.*(^|\s)(-[dD]|--delete)\b/.test(args)) return true;
  if (/^tag\b.*(^|\s)(-d|--delete)\b/.test(args)) return true;
  if (/^push\b.*(^|\s)(-[dD]|--delete)\b/.test(args)) return true;
  if (/^push\b.*(^|\s)\S+:\S*(\s|$)/.test(args)) return true; // `git push origin :branch`
  if (/^stash\b\s+(drop|clear)\b/.test(args)) return true;
  if (/^clean\b/.test(args) && /(^|\s)-[a-zA-Z]*f/.test(args)) return true;
  if (/^worktree\b\s+remove\b/.test(args)) return true;
  if (/^notes\b.*\b(remove|prune)\b/.test(args)) return true;
  if (/^reset\b/.test(args) && /(^|\s)--hard\b/.test(args)) return true;
  if (/^restore\b/.test(args)) {
    // `--staged` alone only touches the index; anything else rewrites the worktree.
    const stagedOnly =
      /(^|\s)(--staged|-S)(\s|$)/.test(args) && !/(^|\s)(--worktree|-W)(\s|$)/.test(args);
    return !stagedOnly;
  }
  if (/^checkout\b/.test(args)) {
    if (/(^|\s)(-f|--force)\b/.test(args)) return true;
    if (/(^|\s)--(\s|$)/.test(args)) return true; // `git checkout -- <path>`
    if (/(^|\s)\.(\s|$)/.test(args)) return true; // `git checkout .`
    return false;
  }
  return false;
}

function isDestructiveSegment(segment: string): boolean {
  let s = segment.trim().replace(/^[({]+|[)}]+$/g, "").trim();
  if (!s) return false;
  s = s.replace(/^(sudo|doas)\s+/i, "");
  const m = s.match(/^([^\s]+)\s*(.*)$/s);
  if (!m) return false;
  const bin = m[1].split("/").pop()!.toLowerCase();
  const rest = m[2] ?? "";
  if (FILE_DELETERS.has(bin)) return true;
  if (bin === "git") return isDestructiveGit(rest);
  return false;
}

const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

export function findDestructiveSegments(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .filter(isDestructiveSegment)
    .map((segment) => segment.trim());
}

export function isDestructiveCommand(command: string): boolean {
  return findDestructiveSegments(command).length > 0;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.registerCommand("destructive", {
    description: "Toggle the destructive (deletion) command guard on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(
        `Destructive command guard ${enabled ? "enabled" : "disabled"}`,
        enabled ? "info" : "warning",
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;

    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return undefined;
    }

    const command = event.input.command as string | undefined;
    if (!command) return undefined;

    const destructive = findDestructiveSegments(command);
    if (destructive.length === 0) return undefined;

    const shown = destructive.join("\n");

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked deletion command (no UI to confirm): ${shown}`,
      };
    }

    const choice = await ctx.ui.select(
      `Do you want to allow pi to run:\n${shown}`,
      ["1. Allow", "2. Deny"],
    );

    if (choice !== "1. Allow") {
      return { block: true, reason: `User denied deletion command: ${shown}` };
    }

    return undefined;
  });
}
