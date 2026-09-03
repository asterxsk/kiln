import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { filterSkillsPrompt } from "./src/filter.js";
import { loadSkillState, loadSkillStateSync, saveSkillState } from "./src/persistence.js";
import { SkillConfView } from "./src/ui/SkillConfView.js";

export default function (pi: ExtensionAPI) {
  // Strip disabled skills from the system prompt every turn so they cost
  // zero context. Skills are keyed by Skill.name, matching the <name> block
  // pi renders into <available_skills>.
  pi.on("before_agent_start", async (event, _ctx) => {
    try {
      const state = loadSkillStateSync();
      if (!state.disabled || state.disabled.length === 0) return;
      const systemPrompt = (event as unknown as { systemPrompt?: string }).systemPrompt;
      if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return;
      const next = filterSkillsPrompt(systemPrompt, state.disabled);
      if (next !== systemPrompt) return { systemPrompt: next };
    } catch {}
  });

  async function openSkillConf(ctx: any) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/skillsconf requires TUI mode", "error");
      return;
    }
    let skills: Array<{ name: string; description: string; filePath: string }> = [];
    try {
      const opts = ctx.getSystemPromptOptions?.() as
        | { skills?: Array<{ name: string; description?: string; filePath?: string }> }
        | undefined;
      skills = (opts?.skills ?? []).map((s) => ({
        name: s.name,
        description: s.description ?? "",
        filePath: s.filePath ?? "",
      }));
    } catch {}
    const state = await loadSkillState();

    await ctx.ui.custom((tui: any, theme: any, kb: any, done: any) => {
      const view = new SkillConfView({
        tui,
        theme,
        keybindings: kb,
        skills,
        disabledRaw: state.disabled,
        packagesRaw: state.packages,
        onDone: (saved: boolean, discarded?: boolean) => {
          done(saved);
          try {
            tui?.requestRender?.();
          } catch {}
          if (!saved && discarded) {
            try {
              ctx.ui.notify("skillsconf: changes discarded (not saved)", "warning");
            } catch {}
          }
        },
        onPersist: async (disabled, packages) => {
          await saveSkillState(disabled, packages, skills.map((s) => s.name));
          const enabledCount = skills.length - (disabled?.length ?? 0);
          try {
            ctx.ui.notify(
              `skillsconf: saved ${enabledCount}/${skills.length} skills enabled, ${Object.keys(packages).length} packages`,
              "info",
            );
          } catch {}
          // No reload: saves are in-place and the UI stays open. The
          // before_agent_start hook re-reads settings from disk every turn.
        },
      });

      return {
        render: view.render.bind(view),
        handleInput: view.handleInput.bind(view),
        invalidate: view.invalidate.bind(view),
      };
    });
  }

  pi.registerCommand("skillsconf", {
    description:
      "Enable/disable skills and manage skill packages (space toggle, s save, n package, a assign, d delete)",
    handler: async (_args, ctx) => openSkillConf(ctx),
  });

  try {
    (pi as any).registerShortcut?.("ctrl+alt+s" as any, {
      description: "Open skillsconf",
      handler: async (ctx: any) => openSkillConf(ctx),
    });
  } catch {}
}
