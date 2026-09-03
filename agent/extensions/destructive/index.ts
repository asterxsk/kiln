/**
 * destructive - Asks before running destructive (deletion) commands.
 *
 * Intercepts `bash` / `powershell` tool calls and prompts:
 *
 *   Do you want to allow pi to run:
 *   {full-command}
 *
 *   1. Allow
 *   2. Deny
 *
 * Anything else (including Deny, or dismissing with Esc) blocks the command.
 * In non-interactive mode (no UI) deletion commands are blocked by default.
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

export function isDestructiveCommand(command: string): boolean {
  return command.split(/&&|\|\||;|\||\n/).some(isDestructiveSegment);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return undefined;
    }

    const command = event.input.command as string | undefined;
    if (!command || !isDestructiveCommand(command)) return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked deletion command (no UI to confirm): ${command}`,
      };
    }

    const choice = await ctx.ui.select(
      `Do you want to allow pi to run:\n${command}`,
      ["1. Allow", "2. Deny"],
    );

    if (choice !== "1. Allow") {
      return { block: true, reason: `User denied deletion command: ${command}` };
    }

    return undefined;
  });
}
