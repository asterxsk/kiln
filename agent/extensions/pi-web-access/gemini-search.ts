import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { searchWithExa } from "./exa.ts";

export interface FullSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export interface ProviderAvailability {
	all: boolean;
	exa: boolean;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: "exa";
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const result = await searchWithExa(query, options);
	if (!result) throw new Error("Exa search returned no results.");
	return { ...result, provider: "exa" };
}
