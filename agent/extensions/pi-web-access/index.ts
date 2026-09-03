import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum, type ImageContent, type TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import { resolveAuthFetchProfile, type AuthFetchProfile } from "./auth-fetch.ts";
import { findContent, type FindMode } from "./content-find.ts";
import { answerFromPage } from "./page-query.ts";
import { clearCloneCache } from "./github-extract.ts";
import { search, type ProviderAvailability } from "./gemini-search.ts";
export type { ProviderAvailability } from "./gemini-search.ts";
import type { SearchResult } from "./search-types.ts";
import { formatSeconds, getWebSearchConfigPath, installGlobalProxyFetch, runWithProxy } from "./utils.ts";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	getResult,
	restoreFromSession,
	storeFetchedContentResult,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import { existsSync, readFileSync } from "node:fs";
import { isExaAvailable } from "./exa.ts";
import { getActiveGoogleEmail, getGeminiWebAvailabilityDiagnostic, getGeminiWebAvailabilityDiagnosticDetails, isGeminiWebAvailable } from "./gemini-web.ts";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";
import { buildSearchErrorPlan, type SearchErrorDetails, type SearchErrorPlan } from "./render-search-error.ts";
import {
	buildResearchArtifact,
	withClaimAssessment,
	storeResearchArtifact,
	getResearchArtifact,
	type RecencyFilter,
	type ResearchArtifact,
} from "./source-check.ts";

type ExtensionTheme = ExtensionContext["ui"]["theme"];

const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const extractModule = await (extractModulePromise ??= import("./extract.ts"));
	return extractModule.fetchAllContent(urls, signal, options);
}

function withRegisteredFetchOptions(
	options: ExtractOptions | undefined,
	toolNames: ExtractOptions["toolNames"],
	proxy?: string,
): ExtractOptions {
	return {
		...(options ?? {}),
		toolNames,
		...(proxy !== undefined ? { proxy } : {}),
	};
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

/** Shared collapsed/expanded renderer for an error/cancel plan produced by
 * buildSearchErrorPlan(). Used by every tool renderResult's error branch so
 * Ctrl+O (app.tools.expand) reveals diagnostics instead of a dead-end single line. */
function renderSearchErrorPlan(plan: SearchErrorPlan, expanded: boolean, theme: ExtensionTheme) {
	if (expanded) {
		return new Text(plan.expanded.map((l, i) => i === 0 ? theme.fg("error", l) : theme.fg("toolOutput", l)).join("\n"), 0, 0);
	}
	const box = new Box(1, 0, (t) => theme.bg("toolErrorBg", t));
	box.addChild(new Text(theme.fg("error", plan.expanded[0]), 0, 0));
	for (const line of plan.collapsed) {
		box.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (plan.expandHint) {
		box.addChild(new Text(theme.fg("muted", plan.expandHint), 0, 0));
	}
	return box;
}

interface WebSearchConfig {
	anysearchApiKey?: unknown;
	xcrawlApiKey?: unknown;
	brightdataApiKey?: unknown;
	brightdataSerpZone?: unknown;
	kagiApiKey?: unknown;
	ollamaApiKey?: unknown;
	serpbaseApiKey?: unknown;
	serperApiKey?: unknown;
	tinyfishApiKey?: unknown;
	valyuApiKey?: unknown;
	xaiApiKey?: unknown;
	maxInlineContentChars?: unknown;
	webSearch?: {
		enabled?: boolean;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	commands?: Partial<Record<"websearch" | "search" | "google-account", { enabled?: boolean }>>;
	toolNames?: Partial<ToolNames>;
	shortcuts?: {
		activity?: KeyId;
	};
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

function parseConfigRoot(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	return parseConfigRoot(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8")) as WebSearchConfig;
}

type ToolNames = {
	webSearch: string;
	sourceCheck: string;
	fetchContent: string;
	getSearchContent: string;
};

const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	sourceCheck: "source_check",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_SHORTCUTS = { activity: "ctrl+shift+w" } satisfies Record<string, KeyId>;

function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return key !== "webSearch" && key !== "sourceCheck" || config.webSearch?.enabled !== false;
}

function isCommandEnabled(config: WebSearchConfig, name: "websearch" | "search" | "google-account"): boolean {
	return config.commands?.[name]?.enabled !== false;
}

function joinToolNames(names: string[]): string {
	if (names.length === 0) return "stored content";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

function resolveToolNames(config: WebSearchConfig): ToolNames {
	if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) {
		throw new Error(`toolNames in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const names = { ...DEFAULT_TOOL_NAMES };
	for (const key of Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>) {
		const value = config.toolNames?.[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must be a string`);
		const trimmed = value.trim();
		if (!TOOL_NAME_PATTERN.test(trimmed)) {
			throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
		}
		names[key] = trimmed;
	}
	const registeredKeys = (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>)
		.filter(key => isToolEnabled(config, key));
	const seen = new Map<string, keyof ToolNames>();
	for (const key of registeredKeys) {
		const name = names[key];
		const previous = seen.get(name);
		if (previous) throw new Error(`toolNames.${key} duplicates toolNames.${previous} in ${WEB_SEARCH_CONFIG_PATH}`);
		seen.set(name, key);
	}
	return names;
}

function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-web-access] ${message}`);
		return {};
	}
}

function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

async function getProviderAvailability(): Promise<ProviderAvailability> {
	const exa = isExaAvailable();
	return { all: exa, exa };
}

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;


const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

function getMaxInlineContentChars(config = loadConfig()): number {
	const value = config.maxInlineContentChars;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

function storeFetchResult(pi: { appendEntry(type: string, data: unknown): void }, responseId: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }, authProfile?: AuthFetchProfile): boolean {
	if (authProfile?.cache === "off") return false;
	pi.appendEntry("web-search-results", storeFetchedContentResult(responseId, data));
	return true;
}

function initialContentSlice(content: string, maxChars: number): {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
} {
	let endOffset = Math.min(content.length, maxChars);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value]).map(query => query.trim()).filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

interface GetSearchContentParams {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
}

type RawGetSearchContentParams = Omit<GetSearchContentParams, "findMode"> & { findMode?: unknown };

function normalizeFindMode(value: unknown): FindMode | undefined {
	if (value === undefined) return undefined;
	if (value === "exact" || value === "case-insensitive" || value === "fuzzy") return value;
	throw new Error('findMode must be "exact", "case-insensitive", or "fuzzy"');
}

function normalizeGetSearchContentParams(params: RawGetSearchContentParams): GetSearchContentParams {
	const normalized: GetSearchContentParams = { ...params, findMode: normalizeFindMode(params.findMode) };

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatSourceCheckResult(artifact: ResearchArtifact, getSearchContentTool: string | null = DEFAULT_TOOL_NAMES.getSearchContent): string {
	const assessment = artifact.claims?.[0];
	const lines = [`# Source check: ${artifact.query}`, ""];
	if (assessment) {
		lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
		lines.push(`**Rationale:** ${assessment.rationale}`);
		if (assessment.supporting_passages.length > 0) lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(", ")}`);
		if (assessment.contradicting_passages.length > 0) lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`);
		lines.push("");
	}
	if (artifact.sources.length > 0) {
		lines.push("## Sources");
		for (const source of artifact.sources) lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
		lines.push("");
	}
	if (artifact.errors?.length) lines.push(`Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`);
	lines.push(getSearchContentTool
		? `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}).`
		: `Artifact responseId: ${artifact.id}. Content retrieval is not registered.`);
	return lines.join("\n");
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];

	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			lines.push("  " + formatEntryLine(e, theme));
		}
	}

	lines.push(theme.fg("accent", "─".repeat(60)));

	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	const resetSec = Math.ceil(resetMs / 1000);
	lines.push(
		theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
			(resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
	);

	ctx.ui.setWidget("web-activity", lines);
}

function formatEntryLine(
	entry: ActivityEntry,
	theme: ExtensionTheme,
): string {
	const typeStr = entry.type === "api" ? "API" : "GET";
	const target =
		entry.type === "api"
			? `"${truncateToWidth(entry.query || "", 28, "")}"`
			: truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

	const duration = entry.endTime
		? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
		: `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

	let statusStr: string;
	let indicator: string;
	if (entry.error) {
		statusStr = "err";
		indicator = theme.fg("error", "✗");
	} else if (entry.status === null) {
		statusStr = "...";
		indicator = theme.fg("warning", "⋯");
	} else if (entry.status === 0) {
		statusStr = "abort";
		indicator = theme.fg("muted", "○");
	} else {
		statusStr = String(entry.status);
		indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	}

	return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

function handleSessionChange(ctx: ExtensionContext): void {
	abortPendingFetches();
	clearCloneCache();
	sessionActive = true;
	restoreFromSession(ctx);
	// Unsubscribe before clear() to avoid callback with stale ctx
	widgetUnsubscribe?.();
	widgetUnsubscribe = null;
	activityMonitor.clear();
	if (widgetVisible) {
		// Re-subscribe with new ctx
		widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	}
}

export default function (pi: ExtensionAPI) {
	const initConfig = loadConfigForExtensionInit();
	installGlobalProxyFetch();
	const toolNames = resolveToolNames(initConfig);
	const webSearchEnabled = isToolEnabled(initConfig, "webSearch");
	const sourceCheckEnabled = isToolEnabled(initConfig, "sourceCheck");
	const fetchContentEnabled = isToolEnabled(initConfig, "fetchContent");
	const getSearchContentEnabled = isToolEnabled(initConfig, "getSearchContent");
	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = {
		...(webSearchEnabled ? { webSearch: toolNames.webSearch } : {}),
		...(fetchContentEnabled ? { fetchContent: toolNames.fetchContent } : {}),
	};
	const storedContentSources = joinToolNames([
		...(webSearchEnabled ? [toolNames.webSearch] : []),
		...(sourceCheckEnabled ? [toolNames.sourceCheck] : []),
		...(fetchContentEnabled ? [toolNames.fetchContent] : []),
	]);
	const searchQueryDescription = webSearchEnabled
		? `Get content for this query (${toolNames.webSearch})`
		: "Get content for a stored search query";
	const fetchContentStorageNote = getSearchContentEnabled
		? `Full original content is stored for retrieval with ${toolNames.getSearchContent}.`
		: "Full original content is stored internally, but the retrieval tool is not registered.";
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

	function startBackgroundFetch(urls: string[], proxy?: string): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		runWithProxy(proxy, () => fetchAllContent(urls, controller.signal, withRegisteredFetchOptions(undefined, registeredToolNames, proxy)))
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
				const ok = fetched.filter(f => !f.error).length;
				const availability = ok === fetched.length
					? "Full page content now available."
					: ok > 0
						? "Partial page content now available."
						: "No page content was fetched. Stored fetch diagnostics are available.";
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. ${availability}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); });
		return fetchId;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
		proxy?: string;
	}


	function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		let output = "";
		for (const { query, answer, results, error } of opts.results) {
			if (opts.queryList.length > 1) {
				output += `## Query: "${query}"\n\n`;
			}
			if (error) output += `Error: ${error}\n\n`;
			else output += formatSearchSummary(results, answer) + "\n\n";
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
			pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
			output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls, opts.proxy);
			if (fetchId) {
				output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
			}
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;

		return {
			content: [{ type: "text", text: output.trim() }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
			},
		};
	}


	pi.registerShortcut(activityKey, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortPendingFetches();
		clearCloneCache();
		clearResults();
		// Unsubscribe before clear() to avoid callback with stale ctx
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		activityMonitor.clear();
		widgetVisible = false;
	});

	if (webSearchEnabled) pi.registerTool({
		name: toolNames.webSearch,
		label: "Web Search",
		description:
			`Search the web using Exa. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background.`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			proxy: Type.Optional(Type.String({
				description: "http(s) proxy URL (e.g. http://host:port) used for every outbound request in this call (search APIs and content fetches). Node fetch ignores HTTP(S)_PROXY env vars, so set this (or `proxy` in web-search.json) when direct access is blocked; empty string forces direct access.",
			})),
		}),

		async execute(callId, params, signal, onUpdate, ctx) {
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const rawQueryList: unknown[] = Array.isArray(params.queries)
					? params.queries
					: (params.query !== undefined ? [params.query] : []);
				const queryList = normalizeQueryList(rawQueryList);
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

				if (queryList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
						details: { error: "No query provided" },
					};
				}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(query, {
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
					});

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					const message = err instanceof Error ? err.message : String(err);
					searchResults.push({ query, answer: "", results: [], error: message, provider: "exa" });
				}
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				proxy: typeof params.proxy === "string" ? params.proxy : undefined,
			});
			});
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? [input.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
				cancelled?: boolean;
				cancelReason?: string;
				browserConnected?: boolean;
				lastHeartbeatAgeMs?: number | null;
				cancelledQueries?: import("./render-search-error.ts").CancelledQueryDetail[];
			};

			if (isPartial) {
				if (details?.phase === "searching") {
					const progress = details?.progress ?? 0;
					const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
					const query = details?.currentQuery || "";
					const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
					return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
				}
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				// Expandable Ctrl+O diagnostics: which queries completed, per-query errors,
				// browser connection state, cancel reason. See render-search-error.ts.
				const plan = buildSearchErrorPlan(details as SearchErrorDetails);
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			{
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				for (const line of preview.split("\n")) {
					lines.push(theme.fg("dim", line));
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				lines.push(theme.fg("muted", "Fetching:"));
				for (const u of details.fetchUrls.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("dim", "  " + display));
				}
				if (details.fetchUrls.length > 5) {
					lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const box = new Box(1, 0);
				box.addChild(new Text(statusLine, 0, 0));

				let collapsedLines = 1; // statusLine
				{
					const textContent = result.content.find((c) => c.type === "text")?.text || "";
					const firstContentLine = textContent.split("\n").find(l => {
						const t = l.trim();
						return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
					});
					const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
					if (fallbackLine) {
						const preview = fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
						box.addChild(new Text(theme.fg("dim", preview), 0, 0));
						collapsedLines++;
					}
				}
				const moreLines = Math.max(0, totalLines - collapsedLines);
				if (moreLines > 0) {
					box.addChild(new Text(theme.fg("muted", `\n... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`), 0, 0));
				}
				return box;
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	if (sourceCheckEnabled) pi.registerTool({
		name: toolNames.sourceCheck,
		label: "Source Check",
		description: "Check a claim against web sources and return a bounded machine-readable research artifact with exact passage citations.",
		promptSnippet: "Verify a claim with structured source evidence and passage-level citations.",
		parameters: Type.Object({
			claim: Type.String({ description: "The assertion to check against web sources." }),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries (default: the claim)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." })),
			fetchContent: Type.Optional(Type.Boolean({ description: "Fetch up to 5 result pages for exact passage extraction." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency." })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude." })),
			proxy: Type.Optional(Type.String({
				description: "http(s) proxy URL (e.g. http://host:port) used for every outbound request in this call (search APIs and result-page fetches). Empty string forces direct access.",
			})),
		}),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const claim = typeof params.claim === "string" ? params.claim.trim() : "";
				if (!claim) {
					return { content: [{ type: "text", text: "Error: 'claim' is required." }], details: { error: "Missing claim" } };
				}

				const requestedQueries = Array.isArray(params.queries)
					? params.queries.filter((query): query is string => typeof query === "string").map((query) => query.trim()).filter(Boolean)
					: [];
				const queries = (requestedQueries.length > 0 ? requestedQueries : [claim]).slice(0, 8);
				const numResults = typeof params.numResults === "number" && Number.isFinite(params.numResults)
					? Math.min(20, Math.max(1, Math.floor(params.numResults)))
					: 5;
				const domainFilter = Array.isArray(params.domainFilter)
					? params.domainFilter.filter((domain): domain is string => typeof domain === "string")
					: undefined;
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
				const resultsByUrl = new Map<string, SearchResult>();
				const summaries: string[] = [];
				const errors: Array<{ query: string; error: string }> = [];
				let provider: string | undefined;

				for (const query of queries) {
					if (signal?.aborted) break;
					try {
						const response = await search(query, {
							numResults,
							recencyFilter,
							domainFilter,
							signal,
						});
						if (signal?.aborted) break;
						provider ??= response.provider;
						if (response.answer) summaries.push(`${query}: ${response.answer}`);
						for (const result of response.results) {
							if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
						}
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) break;
						errors.push({ query, error: err instanceof Error ? err.message : String(err) });
					}
				}

				const results = [...resultsByUrl.values()].slice(0, 20).map((result, index) => ({ ...result, rank: index + 1 }));
				let fetched: ExtractedContent[] = [];
				if (params.fetchContent && results.length > 0) {
					const urls = results.slice(0, 5).map((result) => result.url);
					try {
						fetched = await fetchAllContent(urls, signal, withRegisteredFetchOptions(undefined, registeredToolNames, typeof params.proxy === "string" ? params.proxy : undefined));
					} catch (err) {
						if (signal?.aborted || isAbortError(err)) throw err;
						fetched = urls.map((url) => ({ url, title: "", content: "", error: err instanceof Error ? err.message : String(err) }));
					}
				}
				const artifact = withClaimAssessment(buildResearchArtifact({
					query: claim,
					provider,
					summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
					results,
					fetched,
					recency: recencyFilter,
					domainFilter,
				}), [claim]);
				if (errors.length > 0) artifact.errors = errors;
				storeResearchArtifact(artifact);
				pi.appendEntry("web-search-results", {
					id: artifact.id,
					type: "research",
					timestamp: artifact.timestamp,
					artifact,
				});
				return {
					content: [{ type: "text", text: formatSourceCheckResult(artifact, getSearchContentEnabled ? toolNames.getSearchContent : null) }],
					details: { responseId: artifact.id, artifact, sourceCount: artifact.sources.length, passageCount: artifact.passages.length },
				};
			});
		},
	});

	if (fetchContentEnabled) pi.registerTool({
		name: toolNames.fetchContent,
		label: "Fetch Content",
		description: `Fetch URL(s) and extract readable content as markdown. Use mode "raw" for exact textual HTTP response bodies or mode "answer" with prompt to answer using only fetched content. Direct image URLs return resized image content. Supports YouTube transcripts, GitHub repositories, PDFs, and local videos. ${fetchContentStorageNote}`,
		promptSnippet:
			"Use to fetch readable or raw URL content, direct images, GitHub repos, and videos. Mode answer answers a prompt using only the fetched source.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: "Question or instruction for video analysis, or the page-local question required by mode answer.",
			})),
			mode: Type.Optional(StringEnum(["readable", "raw", "answer"], {
				description: "Fetch mode: readable (default extraction), raw (exact textual HTTP body), or answer (answer prompt using only fetched content).",
			})),
			answerModel: Type.Optional(Type.String({
				description: "Optional provider/model-id override for mode answer. Defaults to the current Pi model.",
			})),
			timestamp: Type.Optional(Type.String({
				description: "Extract video frame(s) at a timestamp or time range. Single: '1:23:45', '23:45', or '85' (seconds). Range: '23:41-25:00' extracts evenly-spaced frames across that span (default 6). Use frames with ranges to control density; single+frames uses a fixed 5s interval. YouTube requires yt-dlp + ffmpeg; local videos require ffmpeg. Use a range when you know the approximate area but not the exact moment — you'll get a contact sheet to visually identify the right frame.",
			})),
			frames: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 12,
				description: "Number of frames to extract. Use with timestamp range for custom density, with single timestamp to get N frames at 5s intervals, or alone to sample across the entire video. Requires yt-dlp + ffmpeg for YouTube, ffmpeg for local video.",
			})),
			model: Type.Optional(Type.String({
				description: "Override the Gemini model for video/YouTube analysis (e.g. 'gemini-3.6-flash'). Defaults to config or gemini-3.6-flash.",
			})),
			auth: Type.Optional(Type.Union([Type.String(), Type.Boolean()], {
				description: "Opt into an authFetch profile for local browser-cookie fetching. Use a profile name, or true only when exactly one profile exists.",
			})),
			proxy: Type.Optional(Type.String({
				description: "http(s) proxy URL (e.g. http://host:port) used for this fetch. Needed when the target is unreachable directly; localhost and NO_PROXY hosts always bypass the proxy. Empty string forces direct access.",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(params);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			const { urlList, options } = normalized;
			return runWithProxy(options.proxy, async () => {
				const mode = options.mode ?? "readable";
				if (mode === "answer" && !options.prompt) {
					return { content: [{ type: "text", text: "Error: mode answer requires prompt." }], details: { error: "mode answer requires prompt" } };
				}
				if (mode === "raw" && (options.forceClone === true || options.timestamp || options.frames || options.prompt || options.model || options.answerModel)) {
					return { content: [{ type: "text", text: "Error: mode raw cannot be combined with forceClone, prompt, timestamp, frames, model, or answerModel." }], details: { error: "Incompatible raw mode options" } };
				}
				if (mode !== "answer" && options.answerModel) {
					return { content: [{ type: "text", text: "Error: answerModel requires mode answer." }], details: { error: "answerModel requires mode answer" } };
				}
				if (mode === "answer" && options.model) {
					return { content: [{ type: "text", text: "Error: use answerModel, not model, with mode answer." }], details: { error: "model is incompatible with mode answer" } };
				}
				if (mode === "answer" && options.auth !== undefined) {
					return { content: [{ type: "text", text: "Error: auth cannot be combined with mode answer." }], details: { error: "auth cannot be combined with mode answer" } };
				}
				let authFetchProfile: AuthFetchProfile | undefined;
				if (options.auth !== undefined) {
					try {
						authFetchProfile = resolveAuthFetchProfile(options.auth);
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
					}
				}
				if (urlList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No URL provided." }],
						details: { error: "No URL provided" },
					};
				}

				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
					details: { phase: "fetch", progress: 0 },
				});

				const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = options;
				const fetchOptions = mode === "answer"
					? (() => {
						const { prompt: _prompt, ...rest } = extractionOptions;
						return { ...rest, ...(authFetchProfile ? { authFetchProfile } : {}) };
					})()
					: { ...extractionOptions, ...(authFetchProfile ? { authFetchProfile } : {}) };
				const fetchResults = await fetchAllContent(urlList, signal, withRegisteredFetchOptions(fetchOptions, registeredToolNames, options.proxy));
				const presentedResults = mode === "answer"
					? await Promise.all(fetchResults.map(async result => {
						if (result.error) return result;
						if (result.thumbnail || result.mimeType?.startsWith("image/")) {
							return { ...result, error: "Page answer requires textual fetched content" };
						}
						try {
							const answer = await answerFromPage({
								question: options.prompt!,
								pageText: result.content,
								sourceUrl: result.url,
								...(options.answerModel ? { model: options.answerModel } : {}),
							}, ctx, signal);
							return { ...result, content: answer.text };
						} catch (err) {
							return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
						}
					}))
					: fetchResults;
				const successful = presentedResults.filter((r) => !r.error).length;
				const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

				const responseId = generateId();
				const data = {
					id: responseId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetchResults),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				const storedContent = storeFetchResult(pi, responseId, data, authFetchProfile);

				if (urlList.length === 1) {
					const result = presentedResults[0];
					if (result.error) {
						return {
							content: [{ type: "text", text: `Error: ${result.error}` }],
							details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, ...(storedContent ? { responseId } : {}), prompt: params.prompt, timestamp: params.timestamp, frames: params.frames },
						};
					}

					const fullLength = result.content.length;
					const slice = initialContentSlice(result.content, getMaxInlineContentChars());
					const truncated = slice.endOffset < fullLength;
					let output = slice.text;

					if (truncated) {
						output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
						output += storedContent
							? getSearchContentEnabled
								? `Use ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`
								: "Content retrieval is not registered."
							: "Authenticated fetch cache is off; repeat the fetch to read more.";
					}

					const content: Array<TextContent | ImageContent> = [];
					if (result.frames?.length) {
						for (const frame of result.frames) {
							content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
							content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
						}
					} else if (result.thumbnail) {
						content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
					}
					content.push({ type: "text", text: output });

					const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
					return {
						content,
						details: {
							urls: urlList,
							urlCount: 1,
							successful: 1,
							totalChars: fullLength,
							title: result.title,
							...(storedContent ? { responseId } : {}),
							truncated,
							hasImage: imageCount > 0,
							imageCount,
							prompt: params.prompt,
							timestamp: params.timestamp,
							frames: params.frames,
							duration: result.duration,
							mode,
							mimeType: result.mimeType,
							status: result.status,
							totalBytes: slice.totalBytes,
							totalLines: slice.totalLines,
							shownBytes: slice.shownBytes,
							shownLines: slice.shownLines,
						},
					};
				}

				let output = "## Fetched URLs\n\n";
				for (const { url, title, content, error } of presentedResults) {
					if (error) {
						output += `- ${url}: Error - ${error}\n`;
					} else {
						output += `- ${title || url} (${content.length} chars)\n`;
					}
				}
				output += storedContent
					? getSearchContentEnabled
						? `\n---\nUse ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`
						: "\n---\nContent retrieval is not registered."
					: "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";

				return {
					content: [{ type: "text", text: output }],
					details: { urls: urlList, urlCount: urlList.length, successful, totalChars, ...(storedContent ? { responseId } : {}) },
				};
			});
		},

		renderCall(args, theme) {
			const { urlList, options } = normalizeFetchContentParams(args);
			const { prompt, timestamp, frames, model, mode, answerModel, auth } = options;
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (mode && mode !== "readable") {
				lines.push(theme.fg("dim", "  mode: ") + theme.fg("warning", mode));
			}
			if (timestamp) {
				lines.push(theme.fg("dim", "  timestamp: ") + theme.fg("warning", timestamp));
			}
			if (typeof frames === "number") {
				lines.push(theme.fg("dim", "  frames: ") + theme.fg("warning", String(frames)));
			}
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
			}
			if (model) {
				lines.push(theme.fg("dim", "  model: ") + theme.fg("warning", model));
			}
			if (answerModel) {
				lines.push(theme.fg("dim", "  answer model: ") + theme.fg("warning", answerModel));
			}
			if (auth !== undefined) {
				lines.push(theme.fg("dim", "  auth: ") + theme.fg("warning", auth === true ? "true" : auth));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
				hasImage?: boolean;
				imageCount?: number;
				prompt?: string;
				timestamp?: string;
				frames?: number;
				duration?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				const fd = details as typeof details & { urls?: string[] };
				const extras: string[] = [];
				if (typeof fd.urlCount === "number" || typeof fd.successful === "number") {
					extras.push(`urls: ${fd.successful ?? 0}/${fd.urlCount ?? 0} succeeded`);
				}
				if (fd.responseId) extras.push(`response id: ${fd.responseId}`);
				if (fd.urls && fd.urls.length > 0) {
					for (const u of fd.urls.slice(0, 8)) extras.push(`  \u25b8 ${u}`);
					if (fd.urls.length > 8) extras.push(`  ... and ${fd.urls.length - 8} more`);
				}
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
				const imageBadge = imgCount > 1
					? theme.fg("accent", ` [${imgCount} images]`)
					: imgCount === 1
						? theme.fg("accent", " [image]")
						: "";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				if (typeof details?.duration === "number") {
					statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const lines = [statusLine];
				if (details?.prompt) {
					const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
					lines.push(theme.fg("dim", `  prompt: "${display}"`));
				}
				if (details?.timestamp) {
					lines.push(theme.fg("dim", `  timestamp: ${details.timestamp}`));
				}
				if (typeof details?.frames === "number") {
					lines.push(theme.fg("dim", `  frames: ${details.frames}`));
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", getSearchContentEnabled ? " (content stored)" : " (content fetched)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	if (getSearchContentEnabled) {
		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		pi.registerTool({
		name: toolNames.getSearchContent,
		label: "Get Search Content",
		description: `Retrieve bounded content slices or find matching passages in a previous ${storedContentSources} call.`,
		promptSnippet:
			`Use after ${storedContentSources} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`,
		parameters: Type.Object({
			responseId: Type.String({ description: `The responseId from ${storedContentSources}` }),
			query: Type.Optional(Type.String({ description: searchQueryDescription })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for fetched URL content slices (default 0). Ignored when findText is supplied." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxInlineContentChars, description: "Maximum characters to return for fetched URL content slices (default and max are set by maxInlineContentChars). Ignored when findText is supplied." })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find in the selected stored content. When supplied, offset and limit are ignored." })),
			findMode: Type.Optional(StringEnum(["exact", "case-insensitive", "fuzzy"], { description: "Matching mode for findText (default: case-insensitive). Requires findText." })),
		}),

		async execute(_toolCallId, rawParams): Promise<AgentToolResult<Record<string, unknown>>> {
			const params = normalizeGetSearchContentParams(rawParams);
			if (params.findMode !== undefined && params.findText === undefined) {
				return {
					content: [{ type: "text", text: `findMode ${formatInputValue(params.findMode)} requires findText; provide findText or omit findMode.` }],
					details: { error: "findMode requires findText" },
				};
			}
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for responseId ${formatInputValue(params.responseId)}. Use a responseId returned by ${storedContentSources}.` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "research") {
				const artifact = getResearchArtifact(params.responseId);
				if (!artifact) {
					return {
						content: [{ type: "text", text: `Error: stored research artifact for responseId ${formatInputValue(params.responseId)} was not found. Use a responseId returned by ${storedContentSources}.` }],
						details: { error: "Artifact not found", responseId: params.responseId },
					};
				}
				const serialized = JSON.stringify(artifact, null, 2);
				if (params.findText !== undefined) {
					try {
						const found = findContent(serialized, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { responseId: artifact.id, type: "research", contentLength: serialized.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in research artifact for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, responseId: params.responseId, type: "research" },
						};
					}
				}
				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for responseId ${formatInputValue(params.responseId)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for responseId ${formatInputValue(params.responseId)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > serialized.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${serialized.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: serialized.length },
					};
				}
				const endOffset = Math.min(offset + limit, serialized.length);
				const artifactSlice = serialized.slice(offset, endOffset);
				const hasMore = endOffset < serialized.length;
				return {
					content: [{ type: "text", text: artifactSlice }],
					details: { responseId: artifact.id, type: "research", contentLength: serialized.length, offset, limit, returnedChars: artifactSlice.length, nextOffset: hasMore ? endOffset : null, truncated: hasMore },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query ${formatInputValue(params.query)} was not found for responseId ${formatInputValue(params.responseId)}. Received query=${formatInputValue(params.query)}. Available queries: ${available || "none"}. Use one of the available queries or queryIndex.` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query index ${formatInputValue(params.queryIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received queryIndex=${formatInputValue(params.queryIndex)}; valid indexes are 0-${data.queries.length - 1}. Available queries: ${available || "none"}. Use one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex for responseId ${formatInputValue(params.responseId)}. Available queries: ${available || "none"}.` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving query ${formatInputValue(queryData.query)} from responseId ${formatInputValue(params.responseId)}: ${queryData.error}. Check the stored search result and retry with another query or queryIndex if needed.` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				const fullResults = formatFullResults(queryData);
				if (params.findText !== undefined) {
					try {
						const found = findContent(fullResults, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { query: queryData.query, resultCount: queryData.results.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in query ${formatInputValue(queryData.query)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, query: queryData.query },
						};
					}
				}

				return {
					content: [{ type: "text", text: fullResults }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;
				let selectedUrlIndex = -1;

				if (params.url !== undefined) {
					selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL ${formatInputValue(params.url)} was not found for responseId ${formatInputValue(params.responseId)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${available || "  none"}\nUse one of the available URLs or urlIndex.` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					selectedUrlIndex = params.urlIndex;
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
						return {
							content: [{ type: "text", text: `URL index ${formatInputValue(params.urlIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received urlIndex=${formatInputValue(params.urlIndex)}; valid indexes are 0-${data.urls.length - 1}. Available URLs:\n  ${available || "  none"}\nUse one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex for responseId ${formatInputValue(params.responseId)}. Available URLs:\n  ${available || "  none"}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving URL ${formatInputValue(urlData.url)} from responseId ${formatInputValue(params.responseId)}: ${urlData.error}. Check the stored fetch result and retry with another URL or urlIndex if needed.` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				if (params.findText !== undefined) {
					try {
						const found = findContent(urlData.content, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
							details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in URL ${formatInputValue(urlData.url)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, url: urlData.url },
						};
					}
				}

				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for URL ${formatInputValue(urlData.url)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for URL ${formatInputValue(urlData.url)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > urlData.content.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for URL ${formatInputValue(urlData.url)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${urlData.content.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: urlData.content.length },
					};
				}

				const endOffset = Math.min(offset + limit, urlData.content.length);
				const contentSlice = urlData.content.slice(offset, endOffset);
				const hasMore = endOffset < urlData.content.length;
				let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
				if (hasMore || offset > 0) {
					text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
					if (hasMore) {
						text += ` Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
					}
				}

				return {
					content: [{ type: "text", text }],
					details: {
						url: urlData.url,
						title: urlData.title,
						contentLength: urlData.content.length,
						offset,
						limit,
						returnedChars: contentSlice.length,
						nextOffset: hasMore ? endOffset : null,
						truncated: hasMore,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Invalid stored data for responseId ${formatInputValue(params.responseId)}: received type ${formatInputValue(data.type)}. Use a responseId returned by ${storedContentSources}.` }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex, offset, findText } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
				offset?: number;
				findText?: string | string[];
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			if (offset !== undefined) target += target ? ` @ ${offset}` : `offset=${offset}`;
			if (findText !== undefined) {
				const queries = Array.isArray(findText) ? findText : [findText];
				target += `${target ? " · " : ""}find ${queries.length}`;
			}
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
				offset?: number;
				returnedChars?: number;
				nextOffset?: number | null;
				matchCount?: number;
				returnedMatches?: number;
			};

			if (details?.error) {
				const extras: string[] = [];
				if (details.query) extras.push(`query: ${details.query}`);
				if (details.url) extras.push(`url: ${details.url}`);
				else if (details.title) extras.push(`resource: ${details.title}`);
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (typeof details?.matchCount === "number") {
				statusLine = theme.fg("success", details?.title || details?.query || "Content") + theme.fg("muted", ` (${details.matchCount} matches, ${details.returnedMatches ?? 0} shown)`);
			} else if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				const start = details?.offset ?? 0;
				const returned = details?.returnedChars ?? details?.contentLength ?? 0;
				const end = start + returned;
				const slice = details?.nextOffset !== undefined || start > 0
					? `, showing ${start}-${end}`
					: "";
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars${slice})`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
	}

	if (isCommandEnabled(initConfig, "google-account")) pi.registerCommand("google-account", {
		description: "Show the active Google account for Gemini Web",
		handler: async () => {
			if (!isBrowserCookieAccessAllowed()) {
				pi.sendMessage({
					customType: "google-account",
					content: [{ type: "text", text: `Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ${WEB_SEARCH_CONFIG_PATH} to enable it.` }],
					display: true,
					details: { available: false, cookieAccessAllowed: false },
				}, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}

			const cookies = await isGeminiWebAvailable();
			if (!cookies) {
				const diagnostic = getGeminiWebAvailabilityDiagnostic();
				const diagnosticDetails = getGeminiWebAvailabilityDiagnosticDetails();
				const attempted = formatCookieAttempts(diagnosticDetails?.attempts ?? []);
				const text = diagnostic
					? `Gemini Web is unavailable: ${diagnostic}${attempted ? ` Attempted browser profiles: ${attempted}.` : ""}`
					: "Gemini Web is unavailable. Sign into gemini.google.com in a supported Chromium-based browser.";
				pi.sendMessage({
					customType: "google-account",
					content: [{ type: "text", text }],
					display: true,
					details: { available: false, cookieAccessAllowed: true, diagnostic, cookieDiagnostic: diagnosticDetails },
				}, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}

			const email = await getActiveGoogleEmail(cookies);
			const text = email
				? `Active Google account: ${email}`
				: "Gemini Web is available, but the active Google account could not be determined.";

			pi.sendMessage({
				customType: "google-account",
				content: [{ type: "text", text }],
				display: true,
				details: { available: true, email: email ?? null },
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	function formatCookieAttempts(attempts: { browser: string; profile: string; status: string }[]): string {
		return attempts.map(({ browser, profile, status }) => `${browser}/${profile} (${status})`).join(", ");
	}

	if (isCommandEnabled(initConfig, "search")) pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && (r.urls || r.urlMetadata)) {
					return `[${r.id.slice(0, 6)}] ${(r.urls ?? r.urlMetadata ?? []).length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && (selected.urls || selected.urlMetadata)) {
					info += "URLs:\n";
					const urlItems = selected.urls ?? selected.urlMetadata ?? [];
					const urls = urlItems.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						const contentLength = "content" in u ? u.content.length : u.contentLength;
						info += `- ${urlDisplay} (${u.error || `${contentLength} chars`})\n`;
					}
					if (urlItems.length > 10) {
						info += `... and ${urlItems.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
