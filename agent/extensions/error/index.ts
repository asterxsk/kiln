/**
 * error - Transient API-error handling.
 *
 * - Retries retriable API (assistant `stopReason === "error"`) failures up to
 *   MAX_RETRIES (10) with exponential backoff. Retries are extension-driven:
 *   after Pi settles on a retriable error, the extension nudges the agent with
 *   an invisible custom message that triggers a new turn.
 * - Non-retriable errors (or exhausted retries) are shown transiently: a
 *   notification + widget that auto-clears after DISPLAY_MS (5s).
 * - Every API error in chat is collapsed via `message_end` replacement so
 *   errors don't linger as scary walls of text. (Sessions are append-only, so
 *   entries can't be deleted -- collapsing + transient display is the closest
 *   "disappear after 5 seconds" achievable from an extension.)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_RETRIES = 10;
const DISPLAY_MS = 5_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;
const STALE_AFTER_MS = 60_000;

export const ERROR_MAX_RETRIES = MAX_RETRIES;
export const ERROR_DISPLAY_MS = DISPLAY_MS;
const WIDGET_KEY = "error";
const STATUS_KEY = "error";

export function backoffMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

function extractErrorText(msg: any): string {
  const parts: string[] = [];
  if (typeof msg?.errorMessage === "string" && msg.errorMessage) {
    parts.push(msg.errorMessage);
  }
  const content = msg?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        parts.push(block.text);
      }
    }
  } else if (typeof content === "string" && content) {
    parts.push(content);
  }
  return parts.join("\n");
}

/** Context overflow is handled by compaction, never by retry. */
function isContextOverflow(text: string): boolean {
  return /context.*overflow|too many tokens|context.?window|maximum context|prompt.*too.*long|input.*too.*long|context length|token.*limit/i.test(
    text,
  );
}

/** Auth / config / bad-request errors will fail the same way on retry. */
function isNonRetriable(text: string): boolean {
  if (/abort/i.test(text)) return true;
  if (isContextOverflow(text)) return true;
  if (/401|unauthorized|invalid.*api.*key|api key.*invalid|authentication|access denied|forbidden|permission denied/i.test(text)) {
    // 429 is about rate, not permission -- keep it retriable.
    if (/429|rate.?limit/i.test(text)) return false;
    return true;
  }
  if (/invalid_request|invalid.*model|model.*not.*found|model.*does not exist/i.test(text)) {
    return true;
  }
  return false;
}

function looksRetriable(text: string): boolean {
  return (
    /429|rate.?limit|too many requests|please.*try again/i.test(text) ||
    /5\d\d|500|502|503|504|529|overloaded|server error|internal error|bad gateway|service unavailable|gateway timeout/i.test(text) ||
    /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|stream.*drop|connection|temporar/i.test(text) ||
    /\bretry\b|transient/i.test(text)
  );
}

export function isRetriableError(text: string): boolean {
  if (!text) return true; // Unknown API failure: assume transient.
  if (isNonRetriable(text)) return false;
  if (looksRetriable(text)) return true;
  // Unknown error shape: retry (bounded by MAX_RETRIES) rather than giving up.
  return true;
}

function shortError(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  let consecutiveErrors = 0;
  let lastErrorAt = 0;
  let lastErrorText = "";
  let lastErrorRetriable = false;
  let retrying = false;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTransient(ctx: { ui: any }) {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI may be unavailable in headless modes.
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // ignore
    }
  }

  function showTransient(ctx: any, text: string) {
    if (!ctx.hasUI) return;
    const short = shortError(text) || "Unknown API error";
    try {
      ctx.ui.notify(short, "error");
    } catch {
      // ignore
    }
    try {
      ctx.ui.setWidget(WIDGET_KEY, [`API error (dismisses in 5s): ${short}`]);
    } catch {
      // ignore
    }
    if (clearTimer) clearTimeout(clearTimer);
    // Capture ctx: widget clear targets the same session UI.
    clearTimer = setTimeout(() => clearTransient(ctx), DISPLAY_MS);
    (clearTimer as any)?.unref?.();
  }

  function reset() {
    consecutiveErrors = 0;
    lastErrorAt = 0;
    lastErrorText = "";
    lastErrorRetriable = false;
    retrying = false;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    reset();
  });

  // Collapse every API error left in chat + track consecutive failures.
  // IMPORTANT: preserve role/stopReason/errorMessage so Pi's own retry and
  // compaction logic still see the failure; only the rendered text shrinks.
  pi.on("message_end", async (event, ctx) => {
    const msg: any = (event as any).message;
    if (!msg || msg.role !== "assistant") return;

    if (msg.stopReason !== "error") {
      // Any successful assistant message ends the error streak.
      if (consecutiveErrors > 0) {
        consecutiveErrors = 0;
        lastErrorRetriable = false;
        try {
          ctx.ui.setStatus(STATUS_KEY, undefined);
        } catch {
          // ignore
        }
      }
      return;
    }

    const text = extractErrorText(msg);
    const now = Date.now();
    if (now - lastErrorAt > STALE_AFTER_MS) {
      consecutiveErrors = 0;
    }
    consecutiveErrors += 1;
    lastErrorAt = now;
    lastErrorText = text;
    lastErrorRetriable = isRetriableError(text);

    showTransient(ctx as any, text || "API request failed");

    const attemptNote =
      lastErrorRetriable && consecutiveErrors <= MAX_RETRIES
        ? ` (retry ${consecutiveErrors}/${MAX_RETRIES})`
        : " (dismissed)";
    return {
      message: {
        ...msg,
        content: [{ type: "text", text: `[API error${attemptNote} — details shown briefly, then dismissed]` },
        ],
      },
    };
  });

  // Extension-driven retry: only fires after Pi has settled (i.e. Pi's own
  // auto-retry did not recover the turn). Bounded by MAX_RETRIES.
  pi.on("agent_settled", async (_event, ctx) => {
    if (retrying) return;
    if (!lastErrorRetriable) return;
    if (consecutiveErrors === 0 || consecutiveErrors >= MAX_RETRIES) return;
    if (Date.now() - lastErrorAt > STALE_AFTER_MS) return;
    if (!ctx.isIdle()) return;

    const attempt = consecutiveErrors + 1;
    retrying = true;
    try {
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(STATUS_KEY, `Retrying API request (${attempt}/${MAX_RETRIES})…`);
        } catch {
          // ignore
        }
        try {
          ctx.ui.notify(`Retrying API request (${attempt}/${MAX_RETRIES})…`, "info");
        } catch {
          // ignore
        }
      }
      await sleep(backoffMs(attempt));
      if (!ctx.isIdle()) return;
      pi.sendMessage(
        {
          customType: "error-retry",
          content: `Transient API error occurred (attempt ${attempt}/${MAX_RETRIES}): ${shortError(lastErrorText) || "unknown error"}. Please retry the previous request.`,
          display: false,
        } as any,
        { triggerTurn: true } as any,
      );
    } finally {
      retrying = false;
    }
  });

  // Final failure (non-retriable or budget exhausted) is already collapsed in
  // chat by message_end; ensure the status line doesn't stick around.
  pi.on("agent_settled", async (_event, ctx) => {
    if (consecutiveErrors >= MAX_RETRIES && lastErrorRetriable) {
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`API error persisted after ${MAX_RETRIES} attempts — giving up`, "error");
        } catch {
          // ignore
        }
      }
    }
  });
}
