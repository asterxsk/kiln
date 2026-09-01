/**
 * goal — keep the agent working until the goal is achieved.
 *
 * Commands:
 *   /goal <prompt>   Research → design → plan → implement → verify, looping
 *                    until you confirm the goal is achieved.
 *   /goal            Prompts for the goal interactively.
 *
 * After the agent settles, this extension asks whether to keep working, mark
 * the goal achieved, or pause. "Keep working" re-engages the agent until the
 * goal is done. See README.md for the phase-by-phase workflow.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HOME = homedir().replace(/\\/g, "/");
const BRAINSTORMING_SKILL = `${HOME}/.agents/skills/brainstorming/SKILL.md`;
const WRITING_PLANS_SKILL = `${HOME}/.agents/skills/writing-plans/SKILL.md`;

/** Shared closing instruction for every /goal pass. */
const REPORT_TAIL = "When you finish a pass, report what is done, what remains, and whether the goal is achieved.";

/** The goal the agent is currently working toward, or null when idle. */
let activeGoal: string | null = null;

function shortGoal(goal: string): string {
	const s = goal.replace(/\s+/g, " ").trim();
	return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function buildInstruction(goal: string): string {
	return [
		"You are executing a /goal workflow: research, then design, then plan, then implement and verify — working until the goal is achieved.",
		"",
		"GOAL:",
		goal,
		"",
		"Work through the phases in order.",
		"",
		"PHASE 1 — RESEARCH",
		"- Use web_search to research the goal: relevant technologies, existing libraries and approaches, best practices, constraints, and open questions.",
		"- Gather grounded facts to inform the design; cite what you learn in the design doc.",
		"",
		"PHASE 2 — DESIGN",
		`- First read the brainstorming skill: ${BRAINSTORMING_SKILL}. Follow it.`,
		"- Ask clarifying questions one at a time (use ask_user when a choice can be enumerated) to pin down purpose, constraints, and success criteria.",
		"- Propose 2-3 approaches with trade-offs and a recommendation; present the design in sections and get approval after each section.",
		"- When the design is approved, save it to docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md and ask the user to review it.",
		"- STOP here and wait for the user to approve the design doc. Do not begin later phases until the user explicitly approves.",
		"",
		"PHASE 3 — PLAN",
		`- First read the writing-plans skill: ${WRITING_PLANS_SKILL}. Follow it.`,
		"- Write a detailed, bite-sized implementation plan with no placeholders and save it to docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md.",
		"",
		"PHASE 4 — IMPLEMENT AND VERIFY",
		"- Implement the plan: write the actual code, tests, and docs.",
		"- Run the tests and any verification; fix failures until everything passes.",
		"- Verify the goal is actually achieved and working, not just that code was written.",
		"",
		REPORT_TAIL,
	].join("\n");
}

function buildContinueInstruction(goal: string): string {
	return [
		`Continue working toward the goal: ${goal}`,
		"",
		"Review the current state and resume the /goal workflow from where you left off, respecting the phase gates:",
		"- If the design has not been approved yet: present the design and STOP for approval. Do not plan or implement until the user approves.",
		"- If the design is approved but the plan is not written: follow the writing-plans skill and write the plan.",
		"- Otherwise: implement and verify, fixing failures until everything passes.",
		"If you are blocked or need a decision, ask the user.",
		REPORT_TAIL,
	].join("\n");
}

async function runGoal(pi: ExtensionAPI, ctx: ExtensionCommandContext, goal: string): Promise<void> {
	activeGoal = goal;
	if (ctx.isIdle()) {
		await pi.sendUserMessage(buildInstruction(goal));
	} else {
		await pi.sendUserMessage(buildInstruction(goal), { deliverAs: "followUp" });
	}
	ctx.ui.notify("goal: working until achieved", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("goal", {
		description:
			"Keep the agent working until a goal is achieved: web research, brainstorming design, writing-plans plan, implement and verify",
		handler: async (args, ctx) => {
			let goal = (args ?? "").trim();
			if (!goal) {
				if (!ctx.hasUI) {
					console.error("Usage: /goal <goal> - work on it until it is achieved");
					return;
				}
				const typed = await ctx.ui.input("What goal would you like to achieve?", "e.g. add a /goal extension to pi");
				goal = (typed ?? "").trim();
				if (!goal) return;
			}
			await runGoal(pi, ctx, goal);
		},
	});

	// Re-engage the agent after each settle until the goal is achieved.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!activeGoal) return;

		// The interactive loop needs the TUI: awaiting a dialog from inside
		// the settle handler can deadlock RPC clients, and print/JSON modes
		// can't prompt at all. Stop the loop rather than spin.
		if (ctx.mode !== "tui") {
			activeGoal = null;
			return;
		}

		const choice = await ctx.ui.select(`Goal: ${shortGoal(activeGoal)}`, [
			"Continue working toward the goal",
			"Goal achieved - stop",
			"Pause - stop checking",
		]);

		// Esc / cancel → pause, so the loop never runs away.
		if (!choice || choice === "Pause - stop checking") {
			activeGoal = null;
			ctx.ui.notify("goal: paused - take over manually", "info");
			return;
		}

		if (choice === "Goal achieved - stop") {
			activeGoal = null;
			ctx.ui.notify("goal: marked achieved", "info");
			return;
		}

		// "Continue working toward the goal"
		if (ctx.isIdle()) {
			await pi.sendUserMessage(buildContinueInstruction(activeGoal));
		} else {
			await pi.sendUserMessage(buildContinueInstruction(activeGoal), { deliverAs: "followUp" });
		}
		ctx.ui.notify("goal: continuing...", "info");
	});

	// Reset state on session boundaries so a stale goal never leaks into a
	// fresh session (or across /reload).
	pi.on("session_start", () => {
		activeGoal = null;
	});
	pi.on("session_shutdown", () => {
		activeGoal = null;
	});
}
