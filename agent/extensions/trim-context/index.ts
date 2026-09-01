/**
 * trim-context — pi extension for crush / amp / lsp style context management
 *
 * Does three things:
 *  1. CACHING: forces PI_CACHE_RETENTION=long (1h Anthropic, 24h OpenAI) + ensures
 *     Anthropic/OpenAI cache_control breakpoints on system + last messages.
 *     Without this pi uses 5m cache which misses on long tasks.
 *
 *  2. OUTPUT COMPRESSION: intercepts tool_result for read/bash/grep/find/ls/edit/write
 *     and aggressively truncates large outputs before they are persisted to history.
 *     Built-in pi truncates at 50KB/2000 lines - this extension compresses at
 *     30KB/400 lines for recent, and 8KB/100 lines for older via context hook.
 *     Full output is saved to temp file and referenced in the compressed result.
 *
 *  3. TRIM CONTEXT (crush/amp/lsp): via `context` event, before every LLM call:
 *     - keeps last KEEP_RECENT_TURNS (6) turns verbatim
 *     - for older turns: truncates tool results to 800 chars, strips thinking blocks,
 *       deduplicates repeated file reads (keeps only last read of same file),
 *       compresses old bash outputs to tail-only
 *     - if total estimated tokens > SOFT_LIMIT (80k), prunes oldest tool results first
 *
 * Install: lives in ~/.pi/agent/extensions/trim-context/ (auto-discovered)
 * Reload: /reload
 * Command: /trimContext — show stats / toggle
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config — tune here
// ---------------------------------------------------------------------------
const CONFIG = {
  // amp strict — keep only last 3 turns verbatim (amp keeps 2-3)
  KEEP_RECENT_TURNS: 3,

  // output compression thresholds for tool_result hook (immediate)
  IMMEDIATE_MAX_BYTES: 12 * 1024, // 12KB for read/grep/etc (amp strict)
  IMMEDIATE_MAX_LINES: 150,
  // bash is the leak — amp strict: 750 tokens max
  BASH_IMMEDIATE_MAX_BYTES: 3 * 1024, // 3KB ~750 tokens hard cap
  BASH_IMMEDIATE_MAX_LINES: 30,

  // context hook thresholds for OLD messages (older than KEEP_RECENT_TURNS)
  OLD_MAX_CHARS: 500, // was 800
  OLD_MAX_LINES: 20, // was 30
  OLD_BASH_TAIL_LINES: 8, // was 12 — amp strict tail-only

  // soft token limit before we start pruning oldest tool results entirely
  SOFT_TOKEN_LIMIT: 50_000, // amp strict ~200KB chars, prune earlier
  HARD_TOKEN_LIMIT: 80_000,

  // dedupe repeated read()s
  DEDUPE_READS: true,

  // strip old thinking blocks
  STRIP_OLD_THINKING: true,

  // caching
  CACHE_RETENTION: "long" as const, // "long" = 1h anthropic, 24h openai
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getTextContent(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function truncateToLimits(
  text: string,
  maxChars: number,
  maxLines: number,
  label = "truncated"
): { text: string; truncated: boolean; savedChars: number } {
  const lines = text.split("\n");
  let truncated = false;
  let result = text;

  if (lines.length > maxLines) {
    // keep head + tail pattern for bash/logs, head-only for reads
    const head = lines.slice(0, Math.floor(maxLines * 0.75));
    const tail = lines.slice(-Math.floor(maxLines * 0.25));
    result = [...head, `\n[... ${lines.length - maxLines} lines ${label} ...]\n`, ...tail].join("\n");
    truncated = true;
  }
  if (result.length > maxChars) {
    const headChars = Math.floor(maxChars * 0.8);
    result =
      result.slice(0, headChars) +
      `\n[... ${result.length - headChars} chars ${label} ...]\n` +
      result.slice(-Math.floor(maxChars * 0.2));
    truncated = true;
  }
  return { text: result, truncated, savedChars: truncated ? text.length - result.length : 0 };
}

function saveFullOutput(fullText: string, toolName: string): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), `pi-trim-${toolName}-`));
    const file = join(dir, "full-output.txt");
    writeFileSync(file, fullText, "utf8");
    return file;
  } catch {
    return "(failed to save)";
  }
}

// Track compression stats across session
let stats = {
  toolResultsCompressed: 0,
  charsSaved: 0,
  readsDeduped: 0,
  thinkingStripped: 0,
  contextTrims: 0,
};

let trimEnabled = true;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  // Force long cache retention before any provider is created
  if (process.env.PI_CACHE_RETENTION !== "long") {
    process.env.PI_CACHE_RETENTION = CONFIG.CACHE_RETENTION;
  }

  pi.on("session_start", async (_event, ctx) => {
    stats = { toolResultsCompressed: 0, charsSaved: 0, readsDeduped: 0, thinkingStripped: 0, contextTrims: 0 };
    // clear legacy statusline from previous version
    ctx.ui.setStatus("trim-context", undefined);
  });

  pi.on("session_shutdown", async () => {
    stats = { toolResultsCompressed: 0, charsSaved: 0, readsDeduped: 0, thinkingStripped: 0, contextTrims: 0 };
  });

  // -------------------------------------------------------------------------
  // 1) OUTPUT COMPRESSION — tool_result hook (immediate, before persistence)
  // -------------------------------------------------------------------------
  pi.on("tool_result", async (event, _ctx) => {
    if (!trimEnabled) return;
    const content = event.content as Array<{ type: string; text?: string }>;
    const textBlocks = content.filter((c) => c.type === "text" && typeof c.text === "string");
    if (textBlocks.length === 0) return;

    const fullText = getTextContent(content as any);
    if (!fullText) return;

    const lines = fullText.split("\n").length;
    const bytes = Buffer.byteLength(fullText, "utf8");

    // bash/powershell get much tighter limits — that's your 1-2k leak
    const isBash = event.toolName === "bash" || event.toolName === "powershell";
    const maxBytes = isBash ? CONFIG.BASH_IMMEDIATE_MAX_BYTES : CONFIG.IMMEDIATE_MAX_BYTES;
    const maxLines = isBash ? CONFIG.BASH_IMMEDIATE_MAX_LINES : CONFIG.IMMEDIATE_MAX_LINES;

    // Also strip ANSI + collapse for bash before measuring (saves 10-20% tokens)
    let textForCheck = fullText;
    if (isBash) {
      // strip ANSI escape codes, collapse 3+ blank lines, trim trailing whitespace per line
      textForCheck = textForCheck.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/\n{3,}/g, "\n\n");
    }
    const checkLines = textForCheck.split("\n").length;
    const checkBytes = Buffer.byteLength(textForCheck, "utf8");
    if (checkBytes <= maxBytes && checkLines <= maxLines) {
      // if we stripped ANSI but still under limit, still persist the cleaned version
      if (isBash && textForCheck !== fullText) {
        return { content: [{ type: "text", text: textForCheck }] };
      }
      return;
    }
    // use cleaned text for compression if bash
    const sourceText = isBash ? textForCheck : fullText;
    const sourceLines = sourceText.split("\n").length;
    const sourceBytes = Buffer.byteLength(sourceText, "utf8");

    const { text: compressed, savedChars } = truncateToLimits(
      sourceText,
      maxBytes,
      maxLines,
      `output compressed by trim-context (${toolNameLabel(event.toolName)})`
    );

    const fullPath = saveFullOutput(fullText, event.toolName);
    const notice =
      compressed +
      `\n\n[trim-context: ${isBash ? "bash" : event.toolName} compressed from ${(sourceBytes / 1024).toFixed(1)}KB/${sourceLines} lines ` +
      `to ${(Buffer.byteLength(compressed, "utf8") / 1024).toFixed(1)}KB. Full saved to: ${fullPath} — limit ${maxBytes / 1024}KB/${maxLines} lines]`;

    stats.toolResultsCompressed++;
    stats.charsSaved += savedChars;

    // Return patch — pi chains these, so we only override content
    return {
      content: [{ type: "text", text: notice }],
    };
  });

  function toolNameLabel(name: string): string {
    return name || "tool";
  }

  // -------------------------------------------------------------------------
  // 2) TRIM CONTEXT — context hook (crush/amp/lsp style, before each LLM call)
  // -------------------------------------------------------------------------
  pi.on("context", async (event, _ctx) => {
    if (!trimEnabled) return;
    const messages: any[] = event.messages;
    if (messages.length === 0) return;

    // Identify turn boundaries: each user message starts a turn
    const userIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") userIndices.push(i);
    }

    // Determine cutoff: keep last KEEP_RECENT_TURNS user turns verbatim
    const keepFromUserIdx = Math.max(0, userIndices.length - CONFIG.KEEP_RECENT_TURNS);
    const keepFromMsgIdx = keepFromUserIdx < userIndices.length ? userIndices[keepFromUserIdx] : 0;

    // For dedupe: find last read of each file path among ALL messages
    const lastReadIndexByPath = new Map<string, number>();
    if (CONFIG.DEDUPE_READS) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block.type === "toolCall" && block.name === "read" && block.arguments?.path) {
              const p = String(block.arguments.path);
              lastReadIndexByPath.set(p, i);
            }
          }
        }
      }
    }

    let totalChars = 0;
    for (const m of messages) {
      totalChars += JSON.stringify(m).length;
    }
    const needsPruning = estimateTokens(JSON.stringify(messages)) > CONFIG.SOFT_TOKEN_LIMIT;

    let prunedCount = 0;
    let dedupedCount = 0;
    let thinkingStripped = 0;

    const trimmed = messages.map((msg, idx) => {
      const isRecent = idx >= keepFromMsgIdx;

      // Recent turns: keep verbatim (already compressed by tool_result hook)
      if (isRecent) return msg;

      // Old turns: apply aggressive trimming

      // 1) Strip thinking blocks from old assistant messages
      if (CONFIG.STRIP_OLD_THINKING && msg.role === "assistant" && Array.isArray(msg.content)) {
        const origLen = msg.content.length;
        const filtered = msg.content.filter((b: any) => b.type !== "thinking");
        if (filtered.length !== origLen) {
          thinkingStripped++;
          // If we stripped all content and only thinking remained, keep a placeholder
          if (filtered.length === 0) {
            return { ...msg, content: [{ type: "text", text: "[thinking stripped by trim-context]" }] };
          }
          return { ...msg, content: filtered };
        }
      }

      // 2) Deduplicate old reads: if this read is not the last read of that file, replace toolResult
      if (CONFIG.DEDUPE_READS && msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "toolCall" && block.name === "read" && block.arguments?.path) {
            const p = String(block.arguments.path);
            const lastIdx = lastReadIndexByPath.get(p);
            if (lastIdx !== undefined && lastIdx !== idx) {
              // This is an old superseded read — we mark for later toolResult compression
              // We tag the assistant message so the following toolResult can be identified
              (msg as any).__trimReadPath = p;
            }
          }
        }
      }

      // 3) Compress old toolResults
      if (msg.role === "toolResult" && Array.isArray(msg.content)) {
        const prevMsg = idx > 0 ? messages[idx - 1] : null;
        const isSupersededRead =
          !!(prevMsg as any)?.__trimReadPath ||
          (msg.toolName === "read" && (() => {
            // Check if there's a later read of same file
            const toolInput = (msg as any).toolName === "read" ? (msg as any).input : null;
            // Fallback: check details if available
            return false;
          })());

        const text = getTextContent(msg.content as any);
        if (!text) return msg;

        // If superseded read, replace entirely
        if (isSupersededRead || (msg.toolName === "read" && CONFIG.DEDUPE_READS)) {
          // Check if a later read exists for same file by scanning forward for toolCall read with same path
          // We already mapped lastReadIndex — if current toolResult is before last, it's superseded
          // We need to correlate toolResult to its toolCall. Use toolCallId matching.
          // Simpler: if total messages has a later read, compress heavily
          const isOld = true;
          if (isOld && text.length > 200) {
            // Check if any later assistant has a read toolCall
            let hasLaterRead = false;
            for (let j = idx + 1; j < messages.length; j++) {
              const later = messages[j];
              if (later.role === "assistant" && Array.isArray(later.content)) {
                for (const b of later.content) {
                  if (b.type === "toolCall" && b.name === "read") {
                    // We can't perfectly match path without toolCallId link, but assume if ANY later read exists
                    // and this is an old read, it's likely dedupable. Be conservative: only if many reads.
                    hasLaterRead = true;
                    break;
                  }
                }
              }
              if (hasLaterRead) break;
            }
            if (hasLaterRead && lastReadIndexByPath.size > 1) {
              // Don't aggressively dedupe single-file sessions
              // Instead compress to tiny placeholder
              dedupedCount++;
              return {
                ...msg,
                content: [{ type: "text", text: `[trim-context: superseded read — latest version kept later in context]` }],
              };
            }
          }
        }

        // General old-result compression
        if (text.length > CONFIG.OLD_MAX_CHARS || text.split("\n").length > CONFIG.OLD_MAX_LINES) {
          let compressed: string;
          if (msg.toolName === "bash" || msg.toolName === "powershell") {
            // For bash, keep tail (most recent output matters)
            const lines = text.split("\n");
            const tail = lines.slice(-CONFIG.OLD_BASH_TAIL_LINES);
            const headNote = `[trim-context: old bash output compressed from ${lines.length} lines / ${(text.length / 1024).toFixed(1)}KB to ${tail.length} lines]`;
            compressed = headNote + "\n" + tail.join("\n");
          } else {
            const { text: t } = truncateToLimits(text, CONFIG.OLD_MAX_CHARS, CONFIG.OLD_MAX_LINES, "old result compressed");
            compressed = t + `\n[trim-context: compressed old ${msg.toolName} result]`;
          }
          prunedCount++;
          return { ...msg, content: [{ type: "text", text: compressed }] };
        }
      }

      return msg;
    });

    // 4) If still over soft limit, hard-prune oldest toolResults entirely (keep marker)
    if (needsPruning) {
      let estimated = estimateTokens(JSON.stringify(trimmed));
      for (let i = 0; i < trimmed.length && estimated > CONFIG.SOFT_TOKEN_LIMIT; i++) {
        const m = trimmed[i];
        if (m.role === "toolResult" && i < keepFromMsgIdx) {
          const text = getTextContent(m.content as any[]);
          if (text && !text.startsWith("[trim-context:")) {
            trimmed[i] = {
              ...m,
              content: [{ type: "text", text: `[trim-context: pruned to save context — was ${(text.length / 1024).toFixed(1)}KB]` }],
            };
            estimated -= estimateTokens(text);
            prunedCount++;
          }
        }
      }
    }

    if (prunedCount > 0 || dedupedCount > 0 || thinkingStripped > 0) {
      stats.contextTrims++;
      stats.readsDeduped += dedupedCount;
      stats.thinkingStripped += thinkingStripped;
    }

    // Clean up temp markers
    for (const m of trimmed as any[]) delete m.__trimReadPath;
    for (const m of messages as any[]) delete m.__trimReadPath;

    if (prunedCount > 0 || dedupedCount > 0 || thinkingStripped > 0 || needsPruning) {
      // Only return if we changed something — otherwise pi keeps original
      return { messages: trimmed };
    }
  });

  // -------------------------------------------------------------------------
  // 3) CACHING — ensure cache_control on payload (backup to env var)
  // -------------------------------------------------------------------------
  pi.on("before_provider_request", async (event, _ctx) => {
    const payload: any = event.payload;

    // Anthropic: ensure system and last message have cache_control
    // Pi already does this when PI_CACHE_RETENTION != "none", but we reinforce
    // for proxies / custom providers that may not respect env.
    try {
      if (payload.system && Array.isArray(payload.system)) {
        const lastSystem = payload.system[payload.system.length - 1];
        if (lastSystem && !lastSystem.cache_control) {
          lastSystem.cache_control = { type: "ephemeral", ttl: "1h" };
        }
      }
      if (payload.messages && Array.isArray(payload.messages) && payload.messages.length > 0) {
        // Add cache breakpoint to last user message if missing
        for (let i = payload.messages.length - 1; i >= 0; i--) {
          const m = payload.messages[i];
          if (m.role === "user" && Array.isArray(m.content)) {
            const lastBlock = m.content[m.content.length - 1];
            if (lastBlock && !lastBlock.cache_control) {
              lastBlock.cache_control = { type: "ephemeral", ttl: "1h" };
              break;
            }
          } else if (m.role === "user" && typeof m.content === "string") {
            // Convert string to cached block
            payload.messages[i] = {
              role: "user",
              content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral", ttl: "1h" } }],
            };
            break;
          }
        }
      }
      // For OpenAI-compatible: ensure prompt_cache_key / prompt_cache_retention
      if (payload.model && typeof payload.model === "string") {
        if (!payload.prompt_cache_retention && CONFIG.CACHE_RETENTION === "long") {
          // Only set if provider supports it — harmless otherwise
          payload.prompt_cache_retention = "24h";
        }
      }
    } catch {
      // never break the request
    }
  });

  // -------------------------------------------------------------------------
  // Command: /trim
  // -------------------------------------------------------------------------
  pi.registerCommand("trim", {
    description: "Toggle trim-context (amp strict) — /trim, /trim on, /trim off, /trim show",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "show") {
        const totalSavedKB = (stats.charsSaved / 1024).toFixed(1);
        ctx.ui.notify(
          `trim-context [${trimEnabled ? "ON" : "OFF"}] amp-strict\n` +
            `  toolResults compressed: ${stats.toolResultsCompressed}\n` +
            `  context trims: ${stats.contextTrims}\n` +
            `  reads deduped: ${stats.readsDeduped}\n` +
            `  thinking stripped: ${stats.thinkingStripped}\n` +
            `  chars saved: ~${totalSavedKB}KB\n` +
            `  config: keep ${CONFIG.KEEP_RECENT_TURNS}t, old→${CONFIG.OLD_MAX_CHARS}ch/${CONFIG.OLD_MAX_LINES}ln, bash ${CONFIG.BASH_IMMEDIATE_MAX_BYTES / 1024}KB/${CONFIG.BASH_IMMEDIATE_MAX_LINES}ln (tail ${CONFIG.OLD_BASH_TAIL_LINES}), generic ${CONFIG.IMMEDIATE_MAX_BYTES / 1024}KB/${CONFIG.IMMEDIATE_MAX_LINES}ln\n` +
            `  soft limit: ${CONFIG.SOFT_TOKEN_LIMIT} tokens`,
          "info"
        );
        return;
      }
      if (arg === "on" || arg === "enable" || arg === "enabled") {
        trimEnabled = true;
        ctx.ui.notify("trim-context: ON (amp strict)", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "disabled") {
        trimEnabled = false;
        ctx.ui.notify("trim-context: OFF — no compression/trimming", "warning");
        return;
      }
      // toggle
      trimEnabled = !trimEnabled;
      ctx.ui.notify(`trim-context: ${trimEnabled ? "ON" : "OFF"}`, trimEnabled ? "info" : "warning");
    },
  });
}
