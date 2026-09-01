/**
 * Background terminals — start long-running shell processes the model can
 * inspect and stop, but never write to (stdin is ignored at the OS level).
 *
 * Tools (for the LLM):
 * - bg_start: fire-and-forget spawn (command, title, working_dir). Max 8
 *   running at once. The model is notified exactly once when a process exits.
 * - bg_status: peek at one terminal's status + tail-truncated output.
 * - bg_list: list all tracked terminals (running and settled).
 * - bg_kill: SIGTERM→SIGKILL the whole process tree; returns final state.
 *
 * While ≥1 process runs, a one-line widget above the editor shows
 * "N background terminal(s) running • /ps to view". `/ps` opens a two-stage
 * full-screen overlay (list → read-only detail with stdout/stderr toggle).
 *
 * Architecture: Effect v4 core (manager service behind one ManagedRuntime);
 * this file is the async boundary where tool handlers run effects via
 * runTool. Node stream plumbing inside the manager is plain callbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TerminalSnapshot } from "./src/domain.ts";
import { TerminalManager, type TerminalManagerShape } from "./src/manager.ts";
import {
  BG_KILL_PARAMETER_DESCRIPTIONS,
  BG_KILL_TOOL_DESCRIPTION,
  BG_LIST_TOOL_DESCRIPTION,
  BG_START_PARAMETER_DESCRIPTIONS,
  BG_START_PROMPT_GUIDELINES,
  BG_START_PROMPT_SNIPPET,
  BG_START_TOOL_DESCRIPTION,
  BG_STATUS_PARAMETER_DESCRIPTIONS,
  BG_STATUS_TOOL_DESCRIPTION,
  buildKillReport,
  buildStartResult,
  buildStatusResult,
  buildTerminalResultMessage,
  describeTerminal,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createTerminalRuntime,
  runTool,
  type TerminalRuntime,
} from "./src/runtime.ts";
import { sanitizeText } from "./src/ui/output-view.ts";
import { openTerminalPicker } from "./src/ui/ps.ts";
import { createBashTool } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "background-terminals";

const AUTO_PROMOTE_MS = 50_000;
const AUTO_PROMOTE_SEC = AUTO_PROMOTE_MS / 1000;

const RESULT_PREVIEW_LINES = 10;

/** Tool call line: bold-white tool name, 2-space indent (Box adds 1 + Text 1). */
function renderToolCall(name: string, theme: any): Text {
  return new Text(theme.fg("toolTitle", theme.bold(name)), 1, 0);
}

/** Tool result: grey text at 2-space indent, collapsed to a short preview. */
function renderToolResult(result: any, theme: any): Text {
  const text = (result?.content ?? [])
    .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
    .map((c: any) => c.text)
    .join("\n");
  if (!text) return new Text("", 1, 0);
  const lines = text.split("\n");
  const preview = lines.slice(0, RESULT_PREVIEW_LINES);
  let out = theme.fg("toolOutput", preview.join("\n"));
  if (lines.length > RESULT_PREVIEW_LINES) {
    out += theme.fg("dim", `\n... (${lines.length - RESULT_PREVIEW_LINES} more lines)`);
  }
  return new Text(out, 1, 0);
}

export default function (pi: ExtensionAPI) {
  let runtime: TerminalRuntime | undefined;
  let managerPromise: Promise<TerminalManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();

  const getRuntime = () => (runtime ??= createTerminalRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(TerminalManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateWidget(manager));
        updateWidget(manager);
        return manager;
      });
    return managerPromise;
  };

  /** One-line widget directly above the editor, only while ≥1 is running.
   * Called on every manager notification (including per-output-chunk), so it
   * only touches setWidget when the running count actually changes —
   * replacing the widget factory hundreds of times a second would churn
   * component creation for no visible difference. */
  let widgetRunning = 0;
  const updateWidget = (manager: TerminalManagerShape) => {
    if (!ui) return;
    try {
      const running = manager.view
        .list()
        .filter((snap) => snap.status === "running").length;
      if (running === widgetRunning) return;
      widgetRunning = running;
      if (running === 0) {
        ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("warning", "■ ") +
          theme.fg(
            "text",
            `${running} background terminal${running === 1 ? "" : "s"} running`,
          ) +
          theme.fg("dim", " • ") +
          theme.fg("accent", "/ps") +
          theme.fg("dim", " to view");
        return { render: () => [line], invalidate: () => {} };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  };

  const deliverResult = (snap: TerminalSnapshot) => {
    try {
      pi.sendMessage(
        {
          customType: "background-terminal-result",
          content: buildTerminalResultMessage(snap),
          display: true,
          details: {
            id: snap.id,
            title: snap.title,
            status: snap.status,
            exitCode: snap.exitCode,
            signal: snap.signal,
          },
        },
        // followUp: queued until the agent has no more tool calls — never
        // interrupts a mid-turn stream. triggerTurn: wakes the model
        // immediately iff idle; if busy, the queued follow-up is delivered
        // when the current run settles. Either way exactly one delivery.
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch (error) {
      // Session may be shutting down, but retain the snapshot so any later
      // agent-settled flush can retry instead of silently dropping it.
      console.error("background-terminals: failed to deliver result", error);
      return false;
    }
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) {
      if (!deliverResult(snap)) resultDelivery.defer(snap);
    }
  };

  const onSettled = (snap: TerminalSnapshot, consumed: boolean) => {
    if (consumed) {
      // An in-flight bg_kill is returning this settlement itself.
      resultDelivery.consume([snap.id]);
      return;
    }
    // Defer a deep-enough copy: the live snapshot's output views keep
    // mutating (late flushes) after settle.
    resultDelivery.defer({
      ...snap,
      stdout: { ...snap.stdout },
      stderr: { ...snap.stderr },
    });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
  });

  // Drain deferred results when the agent settles: together with the
  // isIdle() fast path above and the Map-keyed delivery (drain clears),
  // double delivery is structurally impossible — whoever drains first wins.
  pi.on("agent_settled", flushResults);

  // /new, /resume, /fork, /reload, and quit all emit session_shutdown for
  // the old extension instance. Processes never survive a session
  // transition: disposing the runtime runs the manager finalizer →
  // disposeAll → every entry scope → SIGTERM→SIGKILL tree kill, each close
  // bounded so a wedged process cannot hang shutdown.
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    try {
      ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    widgetRunning = 0;
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "bg_start",
    label: "Start Background Terminal",
    renderCall: (_args: any, theme: any) => renderToolCall("bg_start", theme),
    renderResult: (result: any, _options: any, theme: any) => renderToolResult(result, theme),
    description: BG_START_TOOL_DESCRIPTION,
    promptSnippet: BG_START_PROMPT_SNIPPET,
    promptGuidelines: BG_START_PROMPT_GUIDELINES,
    parameters: Type.Object({
      command: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.command,
      }),
      title: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.title,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: BG_START_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();

      const command = params.command.trim();
      if (!command) throw new Error("command must not be empty.");

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      // Collapse whitespace (a newline inside a one-line UI row desyncs the
      // TUI renderer) before bounding the length.
      const title =
        params.title.replace(/\s+/g, " ").trim().slice(0, 80) || "terminal";
      const snap = await runTool(
        getRuntime(),
        manager.start({ command, title, cwd }),
      );

      return {
        content: [{ type: "text", text: buildStartResult(snap) }],
        details: { id: snap.id, title: snap.title, cwd, pid: snap.pid },
      };
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Check Background Terminal",
    renderCall: (_args: any, theme: any) => renderToolCall("bg_status", theme),
    renderResult: (result: any, _options: any, theme: any) => renderToolResult(result, theme),
    description: BG_STATUS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: BG_STATUS_PARAMETER_DESCRIPTIONS.id }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap) {
        const known = manager.view.list().map((s) => s.id);
        throw new Error(
          `Unknown terminal id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      // This status is returning the settlement itself; a pending automatic
      // follow-up for the same settle would be a duplicate.
      if (snap.status !== "running") resultDelivery.consume([snap.id]);

      return {
        content: [{ type: "text", text: buildStatusResult(snap) }],
        details: {
          id: snap.id,
          status: snap.status,
          pid: snap.pid,
          exitCode: snap.exitCode,
          signal: snap.signal,
        },
      };
    },
  });

  pi.registerTool({
    name: "bg_list",
    label: "List Background Terminals",
    renderCall: (_args: any, theme: any) => renderToolCall("bg_list", theme),
    renderResult: (result: any, _options: any, theme: any) => renderToolResult(result, theme),
    description: BG_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const terminals = manager.view.list();
      const text =
        terminals.length === 0
          ? "No background terminals."
          : terminals.map((snap) => describeTerminal(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          terminals: terminals.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
            pid: snap.pid,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Kill Background Terminals",
    renderCall: (_args: any, theme: any) => renderToolCall("bg_kill", theme),
    renderResult: (result: any, _options: any, theme: any) => renderToolResult(result, theme),
    description: BG_KILL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: BG_KILL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one terminal id.");

      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown terminal id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.kill(ids), {
        signal,
        interruptMessage:
          "Kill wait aborted; termination continues in the background.",
      });

      // Settlement may have happened before this kill began (or during it,
      // via the killInterest consumed flag). Remove any deferred automatic
      // delivery now that this tool returns the final state itself.
      resultDelivery.consume(ids);

      return {
        content: [{ type: "text", text: buildKillReport(report) }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
            killed: entry.killed,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "background-terminal-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
        exitCode?: number;
        signal?: string;
      };
      const failed = details.status === "failed";
      const killed = details.status === "killed";
      const icon = failed
        ? theme.fg("error", "x")
        : killed
          ? theme.fg("muted", "■")
          : theme.fg("success", "■");
      const how = killed
        ? "killed"
        : (details.signal ?? `exit ${details.exitCode ?? "?"}`);
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`terminal ${details.id ?? "?"}`)) +
        theme.fg("muted", ` · ${details.title ?? ""} · ${how}`);

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line; the Error line (when present) is part
      // of the actual result and must remain visible. The body carries raw
      // process output — sanitize ANSI/control chars or the transcript smears.
      const body = sanitizeText(content.split("\n").slice(1).join("\n").trim());

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Auto-promote long bash to background ---------------------------------
  // If a bash tool call exceeds 50s, abort the blocking call, restart it
  // as a background terminal, and alert the agent + UI. The background
  // result is still delivered as a follow-up when it settles.
  const baseBashTool: any = createBashTool(process.cwd());
  pi.registerTool({
    ...baseBashTool,
    description: `${baseBashTool.description} If execution exceeds ${AUTO_PROMOTE_SEC}s it is automatically promoted to a background terminal (check with bg_status/bg_list or /ps; result arrives as follow-up).`,
    async execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const command: string = params.command;
      const cwd = (ctx as any).cwd ?? process.cwd();
      const title = command.replace(/\s+/g, " ").trim().slice(0, 80) || "bash auto-promoted";

      // Delegate tool bound to the current cwd so built-in bash semantics
      // (shell, env, truncation) stay identical for the fast path.
      const delegateTool: any = createBashTool(cwd);

      let lastPartial = "";
      const wrappedOnUpdate = (update: any) => {
        try {
          const text = update?.content?.[0]?.text;
          if (typeof text === "string") lastPartial = text;
        } catch {}
        if (onUpdate) try { onUpdate(update); } catch {}
      };

      const execAbortController = new AbortController();
      const onIncomingAbort = () => execAbortController.abort();
      if (signal) {
        if (signal.aborted) execAbortController.abort();
        else signal.addEventListener("abort", onIncomingAbort, { once: true });
      }

      const execPromise: Promise<{ kind: "done"; res: any } | { kind: "error"; err: unknown }> = delegateTool
        .execute(toolCallId, params, execAbortController.signal, wrappedOnUpdate, ctx as any)
        .then(
          (res: any) => ({ kind: "done" as const, res }),
          (err: unknown) => ({ kind: "error" as const, err }),
        );

      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timerPromise = new Promise<{ kind: "promote" }>((resolve) => {
        timerId = setTimeout(() => resolve({ kind: "promote" }), AUTO_PROMOTE_MS);
      });

      const race = (await Promise.race([execPromise, timerPromise])) as
        | { kind: "done"; res: any }
        | { kind: "error"; err: unknown }
        | { kind: "promote" };

      if (race.kind !== "promote") {
        if (timerId) clearTimeout(timerId);
        if (signal) signal.removeEventListener("abort", onIncomingAbort);
        if (race.kind === "done") return race.res;
        throw race.err;
      }

      // Timer won — promote to background terminal.
      // Abort the original blocking execution (kills its process tree).
      execAbortController.abort();
      if (signal) signal.removeEventListener("abort", onIncomingAbort);

      // If the caller already aborted (Esc), don't promote — just propagate.
      if (signal?.aborted) {
        try {
          const settled = await execPromise;
          if (settled.kind === "error") throw settled.err;
          return (settled as any).res;
        } catch (e) {
          throw e;
        }
      }

      // Let the aborted exec settle (or timeout after 2s if it hangs).
      try {
        await Promise.race([
          execPromise.catch(() => {}),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}

      let snap: TerminalSnapshot | undefined;
      let spawnError: unknown;
      try {
        const manager = await getManager();
        snap = await runTool(getRuntime(), manager.start({ command, title, cwd }));
      } catch (e) {
        spawnError = e;
      }

      if (!snap || spawnError) {
        const msg = spawnError instanceof Error ? spawnError.message : String(spawnError ?? "unknown error");
        const text = [
          `⚠️ Bash command exceeded ${AUTO_PROMOTE_SEC}s but could not be promoted to a background terminal: ${msg}`,
          "",
          `Command: ${command}`,
          "",
          lastPartial ? `Partial output (first ${AUTO_PROMOTE_SEC}s, truncated):\n${lastPartial.slice(-3000)}` : "No output captured before promotion attempt.",
          "",
          "The original blocking command was aborted. Retry with bg_start directly or free a slot with bg_kill (/ps).",
        ].join("\n");
        if ((ctx as any).hasUI) {
          try { (ctx as any).ui.notify(`Bash auto-promote failed: ${msg}`, "warning"); } catch {}
        }
        return {
          content: [{ type: "text", text }],
          details: { promoted: false, error: msg, command, cwd, partialOutput: lastPartial },
        };
      }

      const partialPreview = lastPartial ? lastPartial.slice(-3000) : "(no output yet)";
      const text = [
        `⏳ Bash command exceeded ${AUTO_PROMOTE_SEC}s and was automatically moved to a background terminal.`,
        "",
        `• Terminal ID: ${snap.id}`,
        `• Title: ${snap.title}`,
        `• Command: ${command}`,
        `• CWD: ${cwd}`,
        `• PID: ${snap.pid ?? "pending"}`,
        "",
        "The original blocking bash call was aborted and the command was restarted as a background terminal. It continues running in the background.",
        `Use bg_status with id "${snap.id}" or bg_list or /ps to inspect output. Its result will be delivered automatically when it finishes.`,
        "",
        lastPartial ? `Partial output captured in first ${AUTO_PROMOTE_SEC}s (truncated):\n${partialPreview}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      if ((ctx as any).hasUI) {
        try { (ctx as any).ui.notify(`Bash auto-promoted to background terminal ${snap.id} (${snap.title})`, "info"); } catch {}
      }

      return {
        content: [{ type: "text", text }],
        details: { promoted: true, id: snap.id, title: snap.title, pid: snap.pid, cwd, command },
      };
    },
  });

  // --- Command ------------------------------------------------------------

  pi.registerCommand("ps", {
    description: "List and inspect background terminals",
    handler: async (_args, ctx) => {
      const manager = await getManager();
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          const terminals = manager.view.list();
          ctx.ui.notify(
            terminals.length === 0
              ? "No background terminals."
              : terminals.map((snap) => describeTerminal(snap)).join("\n"),
            "info",
          );
        }
        return;
      }
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No background terminals yet. The agent starts them with bg_start.",
          "info",
        );
        return;
      }
      await openTerminalPicker(ctx, manager.view);
    },
  });
}
