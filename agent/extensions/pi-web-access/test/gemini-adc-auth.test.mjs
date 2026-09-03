import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const geminiApiModuleUrl = new URL("../gemini-api.ts", import.meta.url).href;
const geminiAdcModuleUrl = new URL("../gemini-adc.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GCLOUD_PROJECT",
	]) {
		delete childEnv[key];
	}
	// macOS homedir() ignores HOME, so pin the ADC file explicitly so tests are hermetic.
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function writeAdc(root, extra = {}) {
	return writeFile(
		join(root, "adc.json"),
		JSON.stringify({
			client_id: "synthetic-client-id",
			client_secret: "synthetic-client-secret",
			refresh_token: "synthetic-refresh-token",
			type: "authorized_user",
			universe_domain: "googleapis.com",
			...extra,
		}) + "\n",
		"utf8",
	);
}

test("Gemini ADC availability requires geminiAuth adc, project, location, and an ADC file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-avail-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n", "utf8");

	// ADC file does not exist yet -> not available.
	const child = runChild(`
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({ adcAvail: adc.isGeminiAdcAvailable(), apiAvail: isGeminiApiAvailable() }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { adcAvail: false, apiAvail: false });

	// Now write an ADC file; availability should flip on.
	await writeAdc(root);
	const child2 = runChild(`
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({ adcAvail: adc.isGeminiAdcAvailable(), apiAvail: isGeminiApiAvailable(), missingProject: (await import(${JSON.stringify(geminiAdcModuleUrl)})).getAdcProject() }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(child2.status, 0, child2.stderr);
	const avail = JSON.parse(child2.stdout.trim());
	assert.equal(avail.adcAvail, true);
	assert.equal(avail.apiAvail, true);
});

test("Gemini ADC config parse errors stay visible", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-config-"));
	await writeFile(join(root, "web-search.json"), "not valid JSON", "utf8");

	const child = runChild(`
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			adc.isGeminiAdcAvailable();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Failed to parse .*web-search\.json/);
});

test("Gemini ADC credential parse errors include the file path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-file-"));
	const adcPath = join(root, "adc.json");
	await writeFile(adcPath, "not valid JSON", "utf8");

	const child = runChild(`
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: adcPath });

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Failed to parse Google Application Default Credentials file at /);
	assert.match(error, /adc\.json/);
});

test("Gemini ADC credential shape errors include the file path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-shape-"));
	const adcPath = join(root, "adc.json");
	await writeFile(adcPath, JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret" }) + "\n", "utf8");

	const child = runChild(`
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: adcPath });

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Failed to parse Google Application Default Credentials file at /);
	assert.match(error, /authorized_user file is missing refresh_token/);
});

test("Gemini ADC rejects malformed token success responses", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-token-shape-"));
	await writeAdc(root);
	const env = { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") };

	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: true, expires_in: "bad" }), { status: 200 });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, env);

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Gemini ADC token exchange returned no access_token/);

	const expires = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "token", expires_in: "bad" }), { status: 200 });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, env);

	assert.equal(expires.status, 0, expires.stderr);
	assert.match(JSON.parse(expires.stdout.trim()).error, /Gemini ADC token exchange returned invalid expires_in/);
});

test("Gemini ADC classifies only credential rejections as CredentialResolutionError", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-classify-"));
	await writeAdc(root);
	const env = { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") };

	const classify = (status, body) => runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: ${status} });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let threw = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			threw = { name: err.name, category: err.category, message: err.message };
		}
		console.log(JSON.stringify({ threw }));
	`, env);

	// Credential rejections -> CredentialResolutionError.
	for (const status of [400, 401, 403]) {
		const out = classify(status, JSON.stringify({ error: "denied" }));
		assert.equal(out.status, 0, out.stderr);
		const { threw } = JSON.parse(out.stdout.trim());
		assert.equal(threw.name, "CredentialResolutionError", `status ${status}`);
		assert.equal(threw.category, "oauth-credential-rejected", `status ${status}`);
		assert.match(threw.message, /OAuth token exchange rejected/, `status ${status}`);
	}

	// Transient failures stay plain Errors so fallbacks still run.
	for (const status of [429, 404, 500, 502, 503]) {
		const out = classify(status, "upstream boom");
		assert.equal(out.status, 0, out.stderr);
		const { threw } = JSON.parse(out.stdout.trim());
		assert.equal(threw.name, "Error", `status ${status}`);
		assert.equal(threw.category, undefined, `status ${status}`);
		assert.match(threw.message, new RegExp(`token exchange failed \\(${status}\\)`), `status ${status}`);
	}
});

test("Gemini ADC does not advertise the Files-API (YouTube/video) path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-video-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n",
		"utf8",
	);

	// ADC only: generate-content paths are available, the Files-API path is not.
	const adcOnly = runChild(`
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({
			adcAvail: adc.isGeminiAdcAvailable(),
			apiAvail: api.isGeminiApiAvailable(),
			videoAvail: api.isGeminiApiAvailableWithVideo(),
		}));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(adcOnly.status, 0, adcOnly.stderr);
	assert.deepEqual(JSON.parse(adcOnly.stdout.trim()), {
		adcAvail: true,
		apiAvail: true,
		videoAvail: false,
	});

	// ADC + API key: the Files-API path becomes available again.
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l", geminiApiKey: "synthetic-key" }) + "\n",
		"utf8",
	);
	const withKey = runChild(`
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		console.log(JSON.stringify({
			apiAvail: api.isGeminiApiAvailable(),
			videoAvail: api.isGeminiApiAvailableWithVideo(),
		}));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(withKey.status, 0, withKey.stderr);
	assert.deepEqual(JSON.parse(withKey.stdout.trim()), { apiAvail: true, videoAvail: true });
});
