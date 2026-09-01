import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear" | "batch";

/**
 * A single operation within a batch call. Mirrors TaskMutationParams minus
 * the `items` field (batches cannot be nested).
 */
export interface BatchItem {
	action: Exclude<TaskAction, "batch" | "list" | "get">;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	subjects?: string[];
	ids?: number[];
	/** Labels to assign to created tasks (index-aligned with subjects, create only) */
	as?: string[];
	/** Reference labels from earlier batch items instead of numeric ids */
	refs?: string[];
}

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	/** Batch mode: list of sub-operations to apply atomically in order. */
	items?: BatchItem[];
	/** Batch create: task subjects for multiple creates in one call. */
	subjects?: string[];
	/** Batch update/get/delete: task ids for operating on multiple tasks in one call. */
	ids?: number[];
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests and the
// pre-refactor schema at `packages/rpiv-todo/todo.ts:512-573`.
// ---------------------------------------------------------------------------

const BatchItemSchema = Type.Object({
	action: StringEnum(["create", "update", "delete", "clear"] as const, {
		description: "create | update | delete | clear",
	}),
	subject: Type.Optional(Type.String({ description: "Subject (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(Type.String({ description: "In-progress spinner label" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status",
		}),
	),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "blockedBy ids (create only)" })),
	addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Add to blockedBy" })),
	removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Remove from blockedBy" })),
	owner: Type.Optional(Type.String({ description: "Owner" })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata" })),
	id: Type.Optional(Type.Number({ description: "Task id (required for update/delete)" })),
	subjects: Type.Optional(Type.Array(Type.String(), { description: "Batch-create subjects" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Batch task ids" })),
	as: Type.Optional(
		Type.Array(Type.String(), {
			description: "Labels for new task ids (e.g. ['$t1'])",
		}),
	),
	refs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Reference earlier item labels (e.g. ['$t1'])",
		}),
	),
});

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear", "batch"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous label while in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	subjects: Type.Optional(
		Type.Array(Type.String(), {
			description: "Batch-create subjects (multiple creates in one call).",
		}),
	),
	ids: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Batch update/get/delete: task ids for operating on multiple tasks in one call.",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
	items: Type.Optional(
		Type.Array(BatchItemSchema, {
			description:
				"Batch mode only: ordered create/update/delete/clear sub-ops. Use 'as'/'refs' to label and cross-reference new ids.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
