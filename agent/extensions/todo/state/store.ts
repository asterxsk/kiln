import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Per-session live state cells, keyed by session id.
 *
 * A single module-level cell was shared between the main session and any
 * in-process subagent session in the same Node process (the extension module
 * is loaded once and cached by URL), so both sessions read/wrote and replayed
 * into the same todos. Keying by `ctx.sessionManager.getSessionId()` gives
 * every session — main or subagent — its own independent state cell.
 *
 * The store remains the single mutation seam and the reducer stays pure.
 */
const states = new Map<string, TaskState>();

/** Fresh empty state (new array instance — never share EMPTY_STATE itself). */
export function emptyState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function cell(sessionId: string): TaskState {
	let s = states.get(sessionId);
	if (!s) {
		s = emptyState();
		states.set(sessionId, s);
	}
	return s;
}

/**
 * Live tasks accessor. Returned `readonly Task[]` so callers (overlay render
 * hook, `/todos` command) cannot mutate the live cell. Consumers must not cast
 * back.
 */
export function getTodos(sessionId: string): readonly Task[] {
	return cell(sessionId).tasks;
}

export function getNextId(sessionId: string): number {
	return cell(sessionId).nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
	return cell(sessionId);
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot.
 */
export function replaceState(sessionId: string, next: TaskState): void {
	states.set(sessionId, next);
}

/**
 * Post-reducer commit seam. Tool execute() calls this with the reducer's
 * `state` output to publish the new canonical state to live readers (overlay,
 * `/todos`).
 */
export function commitState(sessionId: string, next: TaskState): void {
	states.set(sessionId, next);
}

/**
 * Drop a session's cell (called on session_shutdown so cells for ended
 * subagent sessions don't accumulate for the life of the process).
 */
export function dropState(sessionId: string): void {
	states.delete(sessionId);
}

/**
 * Test-setup reset. Wired into the global `test/setup.ts` `beforeEach` via
 * the existing `__resetState` import path. Name preserved verbatim — see
 * Plan §Decisions §Decision 7.
 */
export function __resetState(): void {
	states.clear();
}
