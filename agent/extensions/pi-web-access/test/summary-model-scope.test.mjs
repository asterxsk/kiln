import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findModelWithProviderRouting, loadEnabledModelPatterns, modelMatchesEnabledPatterns } from "../summary-model-scope.ts";

const queryRewriteSrc = readFileSync(new URL("../query-rewrite.ts", import.meta.url), "utf8");

test("summary model scope matches nested provider model ids and thinking suffixes", () => {
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free" },
			["openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "anthropic/claude-sonnet-4" },
			["openrouter/*:low"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "ai21/jamba-large-1.7" },
			["openrouter/nvidia/*"],
		),
		false,
	);
});

test("preferred models resolve through routed providers", () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [routedModel],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		routedModel,
	);
});

test("model resolution preserves the direct registry fallback", () => {
	const configuredModel = { provider: "anthropic", id: "claude-haiku-4-5" };
	const registry = {
		find: () => configuredModel,
		getAvailable: () => [],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		configuredModel,
	);
});

test("routed model resolution follows available-model ordering", () => {
	const firstRoute = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const secondRoute = { provider: "requesty", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [firstRoute, secondRoute],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		firstRoute,
	);
});

test("enabledModels loading uses trusted project settings over global settings", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-agent-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-web-access-project-"));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["global/model"] }));
	await mkdir(join(projectDir, ".pi"));
	await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["project/model"] }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => true }),
			["project/model"],
		);
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => false }),
			["global/model"],
		);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	}
});

test("query rewrite defaults use the refreshed model order", () => {
	assert.match(queryRewriteSrc, /id: "gpt-5-mini"/);
	assert.doesNotMatch(queryRewriteSrc, /gpt-4\.1-mini/);
});
