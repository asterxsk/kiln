import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; ids: number[] }
	| { kind: "update"; results: Array<{ id: number; fromStatus: TaskStatus; toStatus: TaskStatus }> }
	| { kind: "delete"; items: Array<{ id: number; subject: string }> }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; tasks: Task[] }
	| { kind: "clear"; count: number }
	| { kind: "batch"; results: Array<{ index: number; op: Exclude<Op, { kind: "batch" }> }> }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

/**
 * Pure reducer: (state, action, params) → (state, op). Mirrors the
 * `applyTaskMutation` of pre-refactor `todo.ts` minus content/details
 * formatting; the response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer — see Plan §Decisions §Decision 2.
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			// Plural path: subjects[]
			if (params.subjects?.length) {
				const subjects = params.subjects.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
				if (subjects.length === 0) return errorResult(state, "subjects[] requires at least one non-empty subject");

				const createdIds: number[] = [];
				let cursor = state;
				for (const subject of subjects) {
					const subResult = applyTaskMutation(cursor, "create", {
						...params,
						subject,
						subjects: undefined,
					} as TaskMutationParams);
					if (subResult.op.kind === "error") return subResult;
					cursor = subResult.state;
					if (subResult.op.kind === "create") createdIds.push(...subResult.op.ids);
				}
				return { state: cursor, op: { kind: "create", ids: createdIds } };
			}
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", ids: [newTask.id] },
			};
		}

		case "update": {
			// Plural path: ids[]
			if (params.ids?.length) {
				const results: Array<{ id: number; fromStatus: TaskStatus; toStatus: TaskStatus }> = [];
				let cursor = state;
				for (const id of params.ids) {
					const subResult = applyTaskMutation(cursor, "update", {
						...params,
						id,
						ids: undefined,
					} as TaskMutationParams);
					if (subResult.op.kind === "error") return subResult;
					cursor = subResult.state;
					if (subResult.op.kind === "update") results.push(subResult.op.results[0]);
				}
				return { state: cursor, op: { kind: "update", results } };
			}
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "update", results: [{ id: updated.id, fromStatus: current.status, toStatus: newStatus }] },
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			// Plural path: ids[]
			if (params.ids?.length) {
				const tasks: Task[] = [];
				let cursor = state;
				for (const id of params.ids) {
					const subResult = applyTaskMutation(cursor, "get", {
						...params,
						id,
						ids: undefined,
					} as TaskMutationParams);
					if (subResult.op.kind === "error") return subResult;
					cursor = subResult.state;
					if (subResult.op.kind === "get") tasks.push(subResult.op.tasks[0]);
				}
				return { state: cursor, op: { kind: "get", tasks } };
			}
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", tasks: [task] } };
		}

		case "delete": {
			// Plural path: ids[]
			if (params.ids?.length) {
				const items: Array<{ id: number; subject: string }> = [];
				let cursor = state;
				for (const id of params.ids) {
					const subResult = applyTaskMutation(cursor, "delete", {
						...params,
						id,
						ids: undefined,
					} as TaskMutationParams);
					if (subResult.op.kind === "error") return subResult;
					cursor = subResult.state;
					if (subResult.op.kind === "delete") items.push(subResult.op.items[0]);
				}
				return { state: cursor, op: { kind: "delete", items } };
			}
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", items: [{ id: updated.id, subject: updated.subject }] },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}

		case "batch": {
			if (!params.items?.length) {
				return errorResult(state, "batch requires at least one item in items[]");
			}
			type BatchOp = Exclude<Op, { kind: "batch" }>;
			const results: Array<{ index: number; op: BatchOp }> = [];
			let currentState = state;
			const refRegistry = new Map<string, number>();

			for (let i = 0; i < params.items.length; i++) {
				const item = params.items[i];
				const { action: itemAction, as: itemAs, refs: itemRefs, ...itemParams } = item;

				// Validate "as" labels
				if (itemAs?.length) {
					if (itemAction !== "create") {
						return errorResult(state, `batch item ${i}: "as" only valid for create actions`);
					}
					const taskCount = item.subjects?.length ?? 1;
					if (itemAs.length !== taskCount) {
						return errorResult(state, `batch item ${i}: "as" (${itemAs.length}) must match task count (${taskCount})`);
					}
					for (const label of itemAs) {
						if (refRegistry.has(label)) {
							return errorResult(state, `batch item ${i}: duplicate as label "${label}"`);
						}
					}
				}

				// Resolve "refs" → ids
				if (itemRefs?.length) {
					const resolvedIds: number[] = [];
					for (const ref of itemRefs) {
						const id = refRegistry.get(ref);
						if (id === undefined) {
							return errorResult(state, `batch item ${i}: ref "${ref}" not defined in earlier items`);
						}
						resolvedIds.push(id);
					}
					itemParams.ids = resolvedIds;
				}

				// Block list/get in batch (read-only ops)
				if ((itemAction as string) === "list" || (itemAction as string) === "get") {
					return errorResult(state, `batch item ${i}: action "${itemAction}" not allowed in batch (use list/get separately)`);
				}

				const sub = applyTaskMutation(currentState, itemAction, itemParams as TaskMutationParams);
				if (sub.op.kind === "error") {
					return errorResult(state, `batch item ${i} (${itemAction}): ${(sub.op as { kind: "error"; message: string }).message}`);
				}
				currentState = sub.state;

				// Register "as" labels after successful create
				if (itemAs?.length && sub.op.kind === "create") {
					sub.op.ids.forEach((id, idx) => {
						if (idx < itemAs.length) {
							refRegistry.set(itemAs[idx], id);
						}
					});
				}

				results.push({ index: i, op: sub.op as BatchOp });
			}

			return {
				state: currentState,
				op: { kind: "batch", results },
			};
		}
	}
}
