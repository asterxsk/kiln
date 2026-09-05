/**
 * destructive - Asks before running destructive (deletion) commands.
 *
 * Intercepts `bash` / `powershell` tool calls and prompts:
 *
 *   Do you want to allow pi to run:
 *   {destructive-segment(s) only}
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

export function getDestructiveSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && isDestructiveSegment(segment));
}

export function isDestructiveCommand(command: string): boolean {
  return getDestructiveSegments(command).length > 0;
}

export default function (pi: ExtensionAPI) {
  let destructiveEnabled = true;

  pi.registerCommand("destructive", {
    description: "Toggle destructive-command guard — /destructive, /destructive on, /destructive off",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "on" || arg === "enable" || arg === "enabled") {
        destructiveEnabled = true;
        ctx.ui.notify("destructive guard: ON — deletion commands need confirmation", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "disabled") {
        destructiveEnabled = false;
        ctx.ui.notify("destructive guard: OFF — deletion commands run without confirmation", "warning");
        return;
      }
      // toggle
      destructiveEnabled = !destructiveEnabled;
      ctx.ui.notify(
        `destructive guard: ${destructiveEnabled ? "ON" : "OFF"}`,
        destructiveEnabled ? "info" : "warning",
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!destructiveEnabled) return undefined;
    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return undefined;
    }

    const command = event.input.command as string | undefined;
    const destructiveParts = command ? getDestructiveSegments(command) : [];
    if (!command || destructiveParts.length === 0) return undefined;

    const display = destructiveParts.join("\n");

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked deletion command (no UI to confirm): ${display}`,
      };
    }

    const choice = await ctx.ui.select(
      `Do you want to allow pi to run:\n${display}`,
      ["1. Allow", "2. Deny"],
    );

    if (choice !== "1. Allow") {
      return { block: true, reason: `User denied deletion command: ${display}` };
    }

    return undefined;
  });
}
