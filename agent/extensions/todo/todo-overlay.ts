/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, 12-line collapse-not-scroll, auto-hide when empty.
 *
 * Reads live state via `getState()` at render time — NEVER `replayFromBranch`
 * from `tool_execution_end` (branch is stale; `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors.js";
import { getState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";
// Budget for content rows (heading + tasks/overflow).
// Reduced by 1 to account for the "Plan · X/Y" header.
const MAX_WIDGET_LINES = 12;


export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	/** Session whose todos this overlay renders (bound at session_start). */
	private sessionId: string | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private agentTurnActive = false;

	/** Bind the overlay to a session's todo cell (re-bound on session switch). */
	setSession(sessionId: string): void {
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.resetCompletedDisplayState();
		}
	}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/** Mark agent turn as active — widget will be visible when todos exist. */
	onAgentTurnStart(): void {
		this.agentTurnActive = true;
		this.update();
	}

	/** Mark agent turn as ended — hide the widget immediately. */
	onAgentTurnEnd(): void {
		this.agentTurnActive = false;
		this.hideWidget();
	}

	update(): void {
		if (!this.uiCtx) return;

		// Widget only visible during active agent turns
		if (!this.agentTurnActive) {
			this.hideWidget();
			return;
		}

		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			this.hideWidget();
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	/** Hide the widget if currently registered. */
	private hideWidget(): void {
		if (this.widgetRegistered && this.uiCtx) {
			this.uiCtx.setWidget(WIDGET_KEY, undefined);
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	private getSnapshot() {
		const state = this.sessionId ? getState(this.sessionId) : { tasks: [], nextId: 1 };
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const showIds = selectShowTaskIds(overlayState);

		const lines: string[] = [];
		lines.push(truncate(theme.fg("dim", `Plan · ${counts.completed}/${counts.total}`)));
		const layout = selectOverlayLayout(overlayState, MAX_WIDGET_LINES - 2);
		for (let i = 0; i < layout.visible.length; i++) {
			const prefix = "┃ ";
			lines.push(truncate(formatOverlayTaskLine(layout.visible[i], theme, showIds, prefix)));
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted > 0 || layout.truncatedTail > 0) {
			const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
			lines.push(truncate(`┃ ${theme.fg("dim", `(... ${totalHidden} more)`)}`));
		}
		return lines;
	}



	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.agentTurnActive = false;
		this.resetCompletedDisplayState();
	}
}
