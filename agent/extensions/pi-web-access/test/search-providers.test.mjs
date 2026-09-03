import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"EXA_API_KEY",
		"EXA_BASE_URL",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Exa direct API key ignores full legacy usage counter", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-paid-"));
	const child = runChild(`
		const dir = ${JSON.stringify(home)};
		const { readFileSync, writeFileSync } = await import("node:fs");
		writeFileSync(dir + "/web-search.json", JSON.stringify({ exaApiKey: "exa-paid-key" }));
		writeFileSync(dir + "/exa-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), count: 1000 }));

		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Paid Exa answer",
				citations: [{ title: "Exa Docs", url: "https://exa.ai/docs" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { isExaAvailable, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = isExaAvailable();
		const result = await searchWithExa("paid exa query");
		const usage = JSON.parse(readFileSync(dir + "/exa-usage.json", "utf8"));
		console.log(JSON.stringify({
			available,
			capturedUrl,
			capturedBody,
			apiKey: capturedHeaders["x-api-key"],
			integration: capturedHeaders["x-exa-integration"],
			result,
			usage,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.capturedUrl, "https://api.exa.ai/answer");
	assert.deepEqual(output.capturedBody, { query: "paid exa query" });
	assert.equal(output.apiKey, "exa-paid-key");
	assert.equal(output.integration, "pi-web-access");
	assert.equal(output.result.answer, "Paid Exa answer");
	assert.deepEqual(output.result.results, [{ title: "Exa Docs", url: "https://exa.ai/docs", snippet: "" }]);
	assert.equal(output.usage.count, 1000);
});

test("Exa command source is lazy, overrides stale env, and rotates per request", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-"));
	const helperPath = join(home, "read-key.mjs");
	const counterPath = join(home, "counter");
	await writeFile(helperPath, `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst counterPath = process.argv[2];\nconst count = (existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0) + 1;\nwriteFileSync(counterPath, String(count));\nprocess.stdout.write("synthetic-exa-" + count);\n`, "utf8");
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		exaApiKey: `!${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} ${JSON.stringify(counterPath)}`,
	}) + "\n", "utf8");

	const child = runChild(`
		import { existsSync } from "node:fs";
		const keys = [];
		globalThis.fetch = async (_url, init) => {
			keys.push(init.headers["x-api-key"]);
			return new Response(JSON.stringify({ answer: "ok", citations: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { hasExaApiKey, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = hasExaApiKey();
		const lazy = !existsSync(${JSON.stringify(counterPath)});
		await searchWithExa("first");
		await searchWithExa("second");
		console.log(JSON.stringify({ available, lazy, keys }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		available: true,
		lazy: true,
		keys: ["synthetic-exa-1", "synthetic-exa-2"],
	});
});

test("failed Exa command source is redacted and fails closed", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-failure-"));
	const commandPath = join(home, "fail-key.mjs");
	await writeFile(commandPath, `process.stderr.write("SYNTHETIC_SECRET_MUST_NOT_ESCAPE\\n");\nprocess.exit(9);\n`, "utf8");
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		exaApiKey: `!${JSON.stringify(process.execPath)} ${JSON.stringify(commandPath)}`,
	}) + "\n", "utf8");

	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let message = "";
		try {
			await search("must fail closed");
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /^Exa credential resolution failed: command-failed$/);
	assert.equal(output.message.includes("SYNTHETIC_SECRET_MUST_NOT_ESCAPE"), false);
	assert.equal(output.message.includes(commandPath), false);
});

test("Exa provider errors redact the resolved credential", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-redaction-"));
	const secret = "SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE";
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify("provider echoed SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE")}, { status: 400 });
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		let message = "";
		try { await searchWithExa("redaction test"); }
		catch (error) { message = error.message; }
		console.log(JSON.stringify({ message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: secret,
	});
	assert.equal(child.status, 0, child.stderr);
	const { message } = JSON.parse(child.stdout.trim());
	assert.equal(message.includes(secret), false);
	assert.equal(message.includes("[redacted]"), true);
});

test("keyless Exa search sends filters to the advanced MCP tool as parameters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-mcp-advanced-"));
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: JSON.stringify({ results: [{
					title: "Advanced result",
					url: "https://docs.example.com/advanced",
					text: "full page text",
					highlights: ["relevant highlight"],
				}] }) }] },
			}), { status: 200 });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("semantic query", {
			numResults: 3,
			recencyFilter: "week",
			domainFilter: ["docs.example.com", "-spam.example.net"],
			includeContent: true,
		});
		console.log(JSON.stringify({ captured, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
	assert.equal(captured.body.params.name, "web_search_advanced_exa");

	const { startPublishedDate, ...args } = captured.body.params.arguments;
	assert.ok(startPublishedDate);
	assert.deepEqual(args, {
		query: "semantic query",
		type: "auto",
		numResults: 3,
		includeDomains: ["docs.example.com"],
		excludeDomains: ["spam.example.net"],
		enableHighlights: true,
		textMaxCharacters: 50000,
	});

	assert.deepEqual(result.results, [{ title: "Advanced result", url: "https://docs.example.com/advanced", snippet: "" }]);
	assert.match(result.answer, /relevant highlight/);
	assert.deepEqual(result.inlineContent, [{
		url: "https://docs.example.com/advanced",
		title: "Advanced result",
		content: "full page text",
		error: null,
	}]);
});

test("keyless Exa search falls back to the default MCP tool when the advanced tool is missing", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-mcp-fallback-"));
	const child = runChild(`
		const tools = [];
		globalThis.fetch = async (url, init) => {
			const target = String(url);
			tools.push(JSON.parse(init.body).params.name);
			if (target.includes("web_search_advanced_exa")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32602, message: "Tool web_search_advanced_exa not found" },
				}), { status: 200 });
			}
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{
					type: "text",
					text: "Title: Basic result\\nURL: https://example.com/basic\\nText: basic text\\n---",
				}] },
			}), { status: 200 });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("fallback query", { domainFilter: ["example.com"] });
		console.log(JSON.stringify({ tools, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const { tools, result } = JSON.parse(child.stdout.trim());
	assert.deepEqual(tools, ["web_search_advanced_exa", "web_search_exa"]);
	assert.deepEqual(result.results, [{ title: "Basic result", url: "https://example.com/basic", snippet: "" }]);
});
