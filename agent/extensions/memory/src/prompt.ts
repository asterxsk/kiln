import { ENTRY_SEPARATOR, type StoreState } from "./store.ts";

const BAR = "═".repeat(46);
const NUM = new Intl.NumberFormat("en-US");

/**
 * Render one store the way Hermes injects it: a banner with the store label and
 * live usage, then the entries delimited by `§`.
 */
export function renderStore(state: StoreState): string {
	const header =
		`${BAR}${state.label} [${state.percent}% — ` +
		`${NUM.format(state.used)}/${NUM.format(state.limit)} chars]${BAR}`;
	return `${header}\n${state.entries.join(ENTRY_SEPARATOR)}`;
}

/** Render every non-empty store, joined into a single system-prompt block. */
export function renderMemoryBlock(states: StoreState[]): string {
	return states
		.filter((state) => state.entries.length > 0)
		.map(renderStore)
		.join("\n\n");
}
