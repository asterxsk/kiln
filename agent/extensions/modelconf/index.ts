import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHiddenModels, getVisibilityMap, saveHiddenModels } from "./src/persistence.js";
import { ModelConfView } from "./src/ui/ModelConfView.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp } from "./src/glob.js";

// ---------- helpers for filtering main /model list ----------
function settingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function loadHiddenModelsSync(): string[] | undefined {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const j = JSON.parse(raw) as { hiddenModels?: string[] };
    return j.hiddenModels;
  } catch {
    return undefined;
  }
}
// Backward compat alias
function loadEnabledModelsSync(): string[] | undefined {
  return loadHiddenModelsSync();
}

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stripThinkingLevel(pattern: string): string {
  const idx = pattern.lastIndexOf(":");
  if (idx !== -1) {
    const suffix = pattern.slice(idx + 1);
    if (VALID_THINKING.has(suffix)) return pattern.slice(0, idx);
  }
  return pattern;
}

function matchesPattern(modelRef: string, pattern: string): boolean {
  const pat = stripThinkingLevel(pattern);
  const lowerRef = modelRef.toLowerCase();
  const lowerPat = pat.toLowerCase();
  const bareId = modelRef.split("/").slice(1).join("/")?.toLowerCase() ?? lowerRef;
  const hasGlob = /[*?\[\]]/.test(pat);
  if (hasGlob) {
    const rx = globToRegExp(pat);
    // pi matches against full ref OR bare id via minimatch
    if (rx.test(modelRef)) return true;
    if (rx.test(bareId)) return true;
    // also try lower variants (globToRegExp is already i-flag)
    return false;
  } else {
    return lowerRef === lowerPat || bareId === lowerPat;
  }
}

function modelMatchesAnyPattern(modelRef: string, patterns: string[]): boolean {
  for (const p of patterns) if (matchesPattern(modelRef, p)) return true;
  return false;
}

function patchRuntime(runtime: any) {
  if (!runtime || runtime.__modelconfPatched) return;
  const origSnapshot = runtime.getAvailableSnapshot?.bind(runtime);
  const origGetAvailable = runtime.getAvailable?.bind(runtime);
  const origGetModels = runtime.getModels?.bind(runtime);

  if (typeof origSnapshot === "function") {
    runtime.getAvailableSnapshot = function (...args: any[]) {
      const base: any[] = origSnapshot(...args);
      const hidden = loadHiddenModelsSync();
      if (!hidden || hidden.length === 0) return base;
      const filtered = base.filter((m: any) => {
        const ref = `${m.provider}/${m.id}`;
        // Hide if matches hidden denylist (from full list). Keep visible otherwise.
        const isHidden = modelMatchesAnyPattern(ref, hidden) || modelMatchesAnyPattern(m.id ?? "", hidden);
        return !isHidden;
      });
      return filtered;
    };
    // keep original for modelconf's own unfiltered view
    runtime.__originalGetAvailableSnapshot = origSnapshot;
  }

  // also patch async getAvailable(providerId, opts) if present
  if (typeof origGetAvailable === "function") {
    runtime.getAvailable = async function (providerId?: string, opts?: any) {
      const base: any[] = await origGetAvailable(providerId, opts);
      const hidden = loadHiddenModelsSync();
      if (!hidden || hidden.length === 0) return base;
      // Always filter hidden from any provider query — hidden applies to full picker list
      const filtered = base.filter((m: any) => {
        const ref = `${m.provider}/${m.id}`;
        const isHidden = modelMatchesAnyPattern(ref, hidden) || modelMatchesAnyPattern(m.id ?? "", hidden);
        return !isHidden;
      });
      return filtered;
    };
    runtime.__originalGetAvailable = origGetAvailable;
  }

  runtime.__modelconfPatched = true;
}

function patchRegistry(registry: any) {
  if (!registry) return;
  // ModelRegistry.getAvailable is async and delegates to runtime; patching runtime is enough.
  // Also patch registry.getAvailableSnapshot if it exists (some pi versions expose it)
  if (typeof registry.getAvailableSnapshot === "function" && !registry.__modelconfPatched) {
    const orig = registry.getAvailableSnapshot.bind(registry);
    registry.getAvailableSnapshot = function (...args: any[]) {
      const base: any[] = orig(...args);
      const hidden = loadHiddenModelsSync();
      if (!hidden || hidden.length === 0) return base;
      const filtered = base.filter((m: any) => {
        const ref = `${m.provider}/${m.id}`;
        return !modelMatchesAnyPattern(ref, hidden);
      });
      return filtered;
    };
    registry.__originalGetAvailableSnapshot = orig;
    registry.__modelconfPatched = true;
  }
  if (registry.runtime) patchRuntime(registry.runtime);
}

export default function modelconf(pi: ExtensionAPI) {
  // patch on session start for every new session's runtime
  try {
    (pi as any).on?.("session_start", async (_ev: any, ctx: any) => {
      try {
        patchRegistry(ctx?.modelRegistry);
      } catch {}
    });
  } catch {}

  // also attempt to patch via global require at load time (best-effort, may be different copy)
  try {
    // try to find main pi runtime via ctx-less import — no-op if not found
    // we rely on patchRegistry on first command invocation as fallback
  } catch {}

  async function openModelConf(ctx: any) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/modelconf requires TUI mode", "error");
      return;
    }

    // Ensure main list filtering is active for this session
    try {
      patchRegistry(ctx.modelRegistry);
    } catch {}

    const rawAll = ctx.modelRegistry.getAll() as any[];
    const allModelsRaw = rawAll.map((m) => ({
      provider: (m as any).provider ?? "unknown",
      id: (m as any).id ?? "",
      name: (m as any).name ?? (m as any).id ?? "",
    }));

    const hiddenRaw = await loadHiddenModels();
    const allIds = allModelsRaw.map((m) => `${m.provider}/${m.id}`);

    // ---- Determine available models (main /model list) as auth-filtered set ----
    // This is the FULL list that /model shows (not the scoped subset). We use
    // hasConfiguredAuth / getProviderAuthStatus to replicate pi's available snapshot.
    const allProvidersSet = new Set<string>(allModelsRaw.map((m) => m.provider));
    const allProviders = [...allProvidersSet];

    const hasConfiguredAuthFn =
      typeof (ctx.modelRegistry as any).hasConfiguredAuth === "function"
        ? (ctx.modelRegistry as any).hasConfiguredAuth.bind(ctx.modelRegistry)
        : null;
    const getProviderAuthStatusFn =
      typeof (ctx.modelRegistry as any).getProviderAuthStatus === "function"
        ? (ctx.modelRegistry as any).getProviderAuthStatus.bind(ctx.modelRegistry)
        : null;

    function isProviderAuthConfigured(provider: string): boolean {
      try {
        if (getProviderAuthStatusFn) {
          const s: any = getProviderAuthStatusFn(provider);
          if (s && (s.ok === true || s.configured === true)) return true;
        }
      } catch {}
      try {
        if (hasConfiguredAuthFn) {
          for (const mm of rawAll) {
            if ((mm as any).provider === provider) {
              try {
                if (hasConfiguredAuthFn(mm)) return true;
              } catch {}
            }
          }
        }
      } catch {}
      return false;
    }

    // Available providers = those with configured auth. Fallback to all if none detected
    // (e.g. no auth yet, to avoid empty view).
    let availableProviders = allProviders.filter((p) => isProviderAuthConfigured(p));
    if (availableProviders.length === 0) availableProviders = allProviders;

    // Full list for modelconf = all models from available providers.
    // This is the same set that /model's main list shows BEFORE enabledModels filtering.
    // We intentionally do NOT filter by enabledModels here — we show the full available
    // catalogue so users can toggle visibility for the main list.
    // If runtime was patched, getAvailableSnapshot would already be filtered; we bypass that
    // by using getAll filtered by auth, not the patched snapshot.
    const allModels = allModelsRaw.filter((m) => availableProviders.includes(m.provider));

    // Visibility: hiddenRaw is denylist for full picker. Visible = not hidden.
    function isVisiblePat(modelRef: string, hidden: string[] | undefined): boolean {
      if (!hidden || hidden.length === 0) return true;
      return !modelMatchesAnyPattern(modelRef, hidden);
    }

    const visibleSet = new Set<string>();
    for (const m of allModels) {
      const ref = `${m.provider}/${m.id}`;
      if (isVisiblePat(ref, hiddenRaw)) visibleSet.add(ref);
    }

        await ctx.ui.custom((tui: any, theme: any, kb: any, done: any) => {
      const view = new ModelConfView({
        tui,
        theme,
        keybindings: kb,
        allModels: allModels as any,
        visibleSet,
        enabledRaw: hiddenRaw,
        allIds,
        onDone: (saved: boolean) => {
          done(saved);
          try {
            tui?.requestRender?.();
          } catch {}
        },
        onPersist: async (nextEnabled: string[] | undefined) => {
          let filtered = nextEnabled;
          if (filtered !== undefined) {
            const allSet = new Set(allIds);
            filtered = filtered.filter((id) => allSet.has(id));
            if (filtered.length === allIds.length) filtered = undefined;
            if (filtered !== undefined) filtered = [...filtered].sort();
          }
          await saveHiddenModels(filtered);
          const hiddenCount = filtered === undefined ? 0 : filtered.length;
          const visibleInAvailable = allModels.length - hiddenCount; // rough; hidden may be outside available but still filtered
          // More accurate: count hidden that are in available
          let hiddenInAvailable = 0;
          if (filtered) {
            hiddenInAvailable = allModels.filter((m) => modelMatchesAnyPattern(`${m.provider}/${m.id}`, filtered!)).length;
          }
          const actualVisible = allModels.length - hiddenInAvailable;
          ctx.ui.notify(
            `modelconf: saved ${hiddenCount} hidden models — ${actualVisible} visible in /model — reload to apply`,
            "info"
          );
          try {
            await (ctx as any).reload?.();
          } catch {}
          // re-patch after save so /model immediately reflects new setting without reload
          try {
            patchRegistry(ctx.modelRegistry);
          } catch {}
        },
      });

      return {
        render: view.render.bind(view),
        handleInput: view.handleInput.bind(view),
        invalidate: view.invalidate.bind(view),
      };
    });
  }

  pi.registerCommand("modelconf", {
    description:
      "Manage main /model list visibility per provider (fuzzy: /, toggle: space, bulk: x, save: enter)",
    handler: async (_args, ctx) => openModelConf(ctx),
  });

  // Also patch /model command to show filtered main list if pi allows overriding.
  // We register a wrapper that ensures filtering is active; we don't replace the UI,
  // filtering is done via runtime patch, so no need to override command.
  // The patch above ensures /model's ModelSelectorComponent automatically shows filtered list.

  try {
    (pi as any).registerShortcut?.("ctrl+alt+m" as any, {
      description: "Open modelconf",
      handler: async (ctx: any) => openModelConf(ctx),
    });
  } catch {}
}
