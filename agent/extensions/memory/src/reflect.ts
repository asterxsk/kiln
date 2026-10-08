/**
 * End-of-response memory reflection.
 *
 * After a turn that did work, the same agent gets one extra provider request to
 * review the conversation and save durable facts through the memory tool. This
 * module holds the pure decision logic and the injected instruction; index.ts
 * wires it to pi's `agent_before_settle` boundary.
 */

/** customType of the hidden nudge message, so we can recognize our own injections. */
export const REFLECT_CUSTOM_TYPE = "memory-reflection";

export const REFLECT_INSTRUCTION =
	"[automatic end-of-turn memory check] " +
	"Review the conversation so far. If it contains durable facts worth remembering " +
	"across sessions — user preferences, machine or environment details, or project " +
	"conventions and gotchas — save them now with the memory tool, choosing the right " +
	"scope ('global' for facts that hold everywhere, 'project' for this repository) and " +
	"target ('memory' for your own notes, 'user' for the user profile). " +
	"Do not save transient task details and do not restate the work. " +
	"If nothing qualifies, reply with no text.";

export type AgentOutcome = "completed" | "aborted" | "error";

export interface ReflectState {
	enabled: boolean;
	/** Already nudged during the current user turn (guards against a continuation loop). */
	done: boolean;
	outcome: AgentOutcome;
	/** The run made at least one non-memory tool call. */
	worked: boolean;
	/** The run already wrote memory, so a reflection would be redundant. */
	usedMemory: boolean;
}

/**
 * Reflect only when enabled, this user turn has not already reflected, the run
 * settled cleanly, the run actually did work, and the agent has not already
 * written memory during the run.
 */
export function shouldReflect(state: ReflectState): boolean {
	return state.enabled && !state.done && state.outcome === "completed" && state.worked && !state.usedMemory;
}

export interface ReflectDraft {
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
}

/** The hidden custom message that asks the agent to review and save memory. */
export function reflectionDraft(): ReflectDraft {
	return { type: "custom_message", customType: REFLECT_CUSTOM_TYPE, content: REFLECT_INSTRUCTION, display: false };
}
