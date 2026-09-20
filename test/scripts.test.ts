import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer, get as httpGet } from "node:http";
import { test } from "node:test";

const COMPARE = resolve("scripts/compare-requests.mjs");
const BISECT = resolve("scripts/bisect-classifier.ts");
const CAPTURE_PROXY = resolve("scripts/capture-proxy.mjs");
const OFFICIAL_CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const AGENT_SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const APPENDED_SDK_IDENTITY =
	"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const FIXTURE_VERSION = "9.8.7";
const MISMATCH_VERSION = "9.8.8";

async function reservePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise<void>((resolvePromise, rejectPromise) =>
		server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
	);
	return address.port;
}

function getText(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const request = httpGet({ host: "127.0.0.1", port, path, timeout: 500 }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			response.on("end", () =>
				resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
			);
		});
		request.on("timeout", () => request.destroy(new Error("health request timed out")));
		request.on("error", rejectPromise);
	});
}

async function waitForHttp(port: number, path: string): Promise<{ status: number; body: string }> {
	const deadline = Date.now() + 3_000;
	while (true) {
		try {
			return await getText(port, path);
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
		}
	}
}

function request(
	billing: string,
	profile = "cli",
	version = FIXTURE_VERSION,
	identity = OFFICIAL_CLI_IDENTITY,
) {
	const sessionId = randomUUID();
	const normalizedBilling =
		billing.includes("cc_prompt_id=") && !billing.includes("cc_turn_origin=")
			? `${billing} cc_turn_origin=${profile === "sdk-cli" ? "sdk" : "human"};`
			: billing;
	return {
		method: "POST",
		url: "https://api.anthropic.com/v1/messages?beta=true",
		headers: {
			authorization: "Bearer sk-ant-REDACTED",
			"user-agent": `claude-cli/${version} (external, ${profile})`,
			"x-app": "cli",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			"x-client-request-id": randomUUID(),
			"x-claude-code-session-id": sessionId,
			"x-claude-code-request-class": "main",
		},
		body: {
			model: "claude-opus-5",
			max_tokens: 64_000,
			stream: true,
			system: [
				{ type: "text", text: normalizedBilling },
				{ type: "text", text: identity },
			],
			tools: [{ name: "Read" }] as Array<{ name: string }>,
			thinking: { type: "adaptive", display: "omitted" },
			output_config: { effort: "xhigh" },
			context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
			diagnostics: { previous_message_id: null },
			metadata: {
				user_id: JSON.stringify({
					device_id: "device-under-test",
					account_uuid: "account-under-test",
					session_id: sessionId,
				}),
			},
		},
	};
}

function compare(claude: unknown, pi: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "claude-native-compare-"));
	try {
		const claudePath = join(dir, "claude.json");
		const piPath = join(dir, "pi.json");
		writeFileSync(claudePath, JSON.stringify(claude));
		writeFileSync(piPath, JSON.stringify(pi));
		return spawnSync(process.execPath, [COMPARE, claudePath, piPath], { encoding: "utf8" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("compare REJECTS a cli provider profile against an sdk-cli capture", () => {
	// `cli` is valid for an interactive capture, but this reference is an
	// `sdk-cli` noninteractive capture. Cross-mode profile pairs must fail loudly.
	const claude = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.abc; cc_entrypoint=sdk-cli; cc_prompt_id=123e4567-e89b-12d3-a456-426614174000;`,
		"sdk-cli",
	);
	const pi = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.def; cc_entrypoint=cli; cch=12345; cc_prompt_id=123e4567-e89b-42d3-a456-426614174001;`,
	);
	const result = compare(claude, pi);
	assert.notEqual(result.status, 0, "a cli-profile provider must not pass as equivalent");
	assert.match(result.stdout, /claude=sdk-cli \| pi=cli/);
});

test("compare accepts a matching sdk-cli pair on both sides", () => {
	const billing = (suffix: string, extra: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli;${extra}`;
	const claude = request(
		billing("abc", " cc_prompt_id=123e4567-e89b-12d3-a456-426614174000;"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	const pi = request(
		billing("def", " cch=12345; cc_prompt_id=123e4567-e89b-42d3-a456-426614174001;"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("compare accepts different URL origins when pathname and search match, but rejects route drift", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(
		billing("abc", "123e4567-e89b-42d3-a456-426614174000"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	const pi = request(
		billing("def", "123e4567-e89b-42d3-a456-426614174001"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	pi.url = "http://127.0.0.1:8118/v1/messages?beta=true";
	assert.equal(compare(claude, pi).status, 0, "proxy origin is intentionally ignored");

	pi.url = "http://127.0.0.1:8118/v1/messages?beta=false";
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  request URL pathname and search match genuine/);
});

test("compare requires POST on both captures and rejects missing or different methods", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const genuine = () =>
		request(billing("abc", "123e4567-e89b-42d3-a456-426614174000"), "sdk-cli", FIXTURE_VERSION, AGENT_SDK_IDENTITY);
	const native = () =>
		request(billing("def", "123e4567-e89b-42d3-a456-426614174001"), "sdk-cli", FIXTURE_VERSION, AGENT_SDK_IDENTITY);

	const piGet = native();
	piGet.method = "GET";
	const getResult = compare(genuine(), piGet);
	assert.equal(getResult.status, 1, getResult.stdout + getResult.stderr);
	assert.match(getResult.stdout, /DIFF  request method is POST on both captures/);

	const claudeMissing = genuine();
	delete (claudeMissing as Partial<typeof claudeMissing>).method;
	const missingResult = compare(claudeMissing, native());
	assert.equal(missingResult.status, 1, missingResult.stdout + missingResult.stderr);
	assert.match(missingResult.stdout, /DIFF  request method is POST on both captures/);
});

test("compare requires the exact known system identity from the genuine capture", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(
		billing("abc", "123e4567-e89b-42d3-a456-426614174000"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	const pi = request(
		billing("def", "123e4567-e89b-42d3-a456-426614174001"),
		"sdk-cli",
		FIXTURE_VERSION,
		OFFICIAL_CLI_IDENTITY,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  system\[1\] matches genuine exactly/);

	claude.body.system[1].text = "unknown identity";
	pi.body.system[1].text = "unknown identity";
	const unknownResult = compare(claude, pi);
	assert.equal(unknownResult.status, 1, unknownResult.stdout + unknownResult.stderr);
	assert.match(unknownResult.stdout, /DIFF  system\[1\] is a known Claude Code identity on both captures/);
});

test("compare recognizes the noninteractive append-system-prompt identity when both captures match", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(
		billing("abc", "123e4567-e89b-42d3-a456-426614174000"),
		"sdk-cli",
		FIXTURE_VERSION,
		APPENDED_SDK_IDENTITY,
	);
	const pi = request(
		billing("def", "123e4567-e89b-42d3-a456-426614174001"),
		"sdk-cli",
		FIXTURE_VERSION,
		APPENDED_SDK_IDENTITY,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("compare accepts matching TUI thinking updates but rejects cross-mode display drift", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(billing("abc", "123e4567-e89b-42d3-a456-426614174000"), "cli", FIXTURE_VERSION);
	const pi = request(billing("def", "123e4567-e89b-42d3-a456-426614174001"), "cli", FIXTURE_VERSION);
	claude.body.thinking.display = "updates";
	pi.body.thinking.display = "updates";
	assert.equal(compare(claude, pi).status, 0, "matching interactive display mode must pass");

	pi.body.thinking.display = "omitted";
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  thinking\.display matches genuine exactly/);
});

test("compare rejects an empty Pi tool list when genuine advertises tools", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(
		billing("abc", "123e4567-e89b-42d3-a456-426614174000"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	const pi = request(
		billing("def", "123e4567-e89b-42d3-a456-426614174001"),
		"sdk-cli",
		FIXTURE_VERSION,
		AGENT_SDK_IDENTITY,
	);
	pi.body.tools = [];

	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  pi request advertises tools when genuine does/);

	pi.body.tools.push({ name: "Read" });
	const matchingResult = compare(claude, pi);
	assert.equal(matchingResult.status, 0, matchingResult.stdout + matchingResult.stderr);
});

test("compare accepts output_config absent on both budget-model requests", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(billing("abc", "123e4567-e89b-42d3-a456-426614174000"), "sdk-cli", FIXTURE_VERSION);
	const pi = request(billing("def", "123e4567-e89b-42d3-a456-426614174001"), "sdk-cli", FIXTURE_VERSION);
	delete (claude.body as Partial<typeof claude.body>).output_config;
	delete (pi.body as Partial<typeof pi.body>).output_config;

	const result = compare(claude, pi);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("compare rejects max_tokens drift from the genuine request", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(billing("abc", "123e4567-e89b-42d3-a456-426614174000"), "sdk-cli", FIXTURE_VERSION);
	const pi = request(billing("def", "123e4567-e89b-42d3-a456-426614174001"), "sdk-cli", FIXTURE_VERSION);
	pi.body.max_tokens = 128_000;

	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  body\.max_tokens matches genuine exactly/);
});

test("compare rejects a wire-model mismatch even when beta and controls match", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const claude = request(billing("abc", "123e4567-e89b-42d3-a456-426614174000"), "sdk-cli", FIXTURE_VERSION);
	const pi = request(billing("def", "123e4567-e89b-42d3-a456-426614174001"), "sdk-cli", FIXTURE_VERSION);
	pi.body.model = "claude-sonnet-5";

	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  body.model matches genuine exactly/);
});

test("compare rejects a Pi billing header that regresses by omitting cc_prompt_id", () => {
	const claude = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.abc; cc_entrypoint=sdk-cli; cch=abcde; cc_prompt_id=123e4567-e89b-42d3-a456-426614174000;`,
		"sdk-cli",
		FIXTURE_VERSION,
	);
	const pi = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.def; cc_entrypoint=sdk-cli; cch=12345;`,
		"sdk-cli",
		FIXTURE_VERSION,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  system\[0\] is a well-formed billing header/);
});

test("compare rejects an unrelated user-agent profile", () => {
	const claude = request(`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.abc; cc_entrypoint=sdk-cli;`, "other");
	const pi = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.def; cc_entrypoint=cli; cch=12345; cc_prompt_id=123e4567-e89b-42d3-a456-426614174001;`,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  header "user-agent" uses compatible client profiles/);
});

test("compare rejects matching user-agents that disagree with both billing versions", () => {
	const claude = request(`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.abc; cc_entrypoint=sdk-cli;`, "sdk-cli", MISMATCH_VERSION);
	const pi = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.def; cc_entrypoint=cli; cch=12345; cc_prompt_id=123e4567-e89b-42d3-a456-426614174001;`,
		"cli",
		MISMATCH_VERSION,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  user-agent and billing fingerprints are internally consistent/);
});

test("compare reports a malformed genuine billing header instead of silently skipping it", () => {
	const claude = request("not a billing header");
	const pi = request(
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.def; cc_entrypoint=cli; cch=12345; cc_prompt_id=123e4567-e89b-42d3-a456-426614174001;`,
	);
	const result = compare(claude, pi);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /DIFF  genuine system\[0\] is a well-formed billing header/);
});

test("compare rejects missing or drifted first-party headers and body controls", () => {
	const billing = (suffix: string, promptId: string) =>
		`x-anthropic-billing-header: cc_version=${FIXTURE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=12345; cc_prompt_id=${promptId};`;
	const genuine = () => request(billing("abc", "123e4567-e89b-42d3-a456-426614174000"), "sdk-cli", FIXTURE_VERSION);
	const native = () => request(billing("def", "123e4567-e89b-42d3-a456-426614174001"), "sdk-cli", FIXTURE_VERSION);
	const cases: Array<[string, (value: ReturnType<typeof request>) => void, RegExp]> = [
		[
			"request class",
			(value) => ((value.headers as Record<string, string>)["x-claude-code-request-class"] = "auxiliary"),
			/x-claude-code-request-class.*matches genuine/,
		],
		[
			"turn origin",
			(value) => {
				value.body.system[0].text = value.body.system[0].text.replace("cc_turn_origin=sdk;", "cc_turn_origin=human;");
			},
			/cc_turn_origin matches the genuine mode/,
		],
		[
			"client request id",
			(value) => ((value.headers as Record<string, string>)["x-client-request-id"] = "not-a-uuid"),
			/x-client-request-id.*UUID-shaped/,
		],
		[
			"session id",
			(value) => ((value.headers as Record<string, string>)["x-claude-code-session-id"] = "not-a-uuid"),
			/x-claude-code-session-id.*UUID-shaped/,
		],
		["stream", (value) => (value.body.stream = false), /body\.stream matches genuine exactly/],
		["thinking display", (value) => (value.body.thinking.display = "summarized"), /thinking\.display matches genuine/],
		["thinking shape", (value) => (value.body.thinking.type = "enabled"), /body "thinking" is present and matches genuine/],
		["output config", (value) => (value.body.output_config.effort = "high"), /body "output_config" matches genuine exactly/],
		["context management", (value) => (value.body.context_management.edits[0].keep = "none"), /context_management.*matches genuine/],
		[
			"diagnostics",
			(value) => ((value.body.diagnostics as { previous_message_id: string | null }).previous_message_id = "stale"),
			/diagnostics.*matches genuine/,
		],
		[
			"metadata json",
			(value) => (value.body.metadata.user_id = "not-json"),
			/metadata\.user_id is a JSON object on both clients/,
		],
		[
			"metadata account",
			(value) => {
				const metadata = JSON.parse(value.body.metadata.user_id);
				metadata.account_uuid = "different-account";
				value.body.metadata.user_id = JSON.stringify(metadata);
			},
			/metadata device_id and account_uuid match genuine/,
		],
		[
			"metadata session",
			(value) => {
				const metadata = JSON.parse(value.body.metadata.user_id);
				metadata.session_id = randomUUID();
				value.body.metadata.user_id = JSON.stringify(metadata);
			},
			/metadata session_id is UUID-shaped and matches each session header/,
		],
	];

	for (const [name, mutate, expected] of cases) {
		const pi = native();
		mutate(pi);
		const result = compare(genuine(), pi);
		assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, expected, name);
	}
});

test("capture proxy returns its configured nonce through the local health endpoint", { timeout: 5_000 }, async (t) => {
	const port = await reservePort();
	const nonce = randomUUID();
	const dir = mkdtempSync(join(tmpdir(), "claude-native-proxy-"));
	const proxy = spawn(process.execPath, [CAPTURE_PROXY], {
		env: {
			...process.env,
			PI_CAPTURE_PORT: String(port),
			PI_CAPTURE_TARGET: "http://127.0.0.1:1",
			PI_CAPTURE_DIR: dir,
			PI_CAPTURE_HEALTH_NONCE: nonce,
		},
		stdio: "ignore",
	});
	t.after(async () => {
		if (proxy.exitCode === null && proxy.signalCode === null) {
			proxy.kill();
			await new Promise<void>((resolvePromise) => proxy.once("exit", () => resolvePromise()));
		}
		rmSync(dir, { recursive: true, force: true });
	});

	const response = await waitForHttp(port, "/__pi_claude_capture_health");
	assert.equal(response.status, 200, response.body);
	assert.deepEqual(JSON.parse(response.body), { service: "pi-claude-capture-proxy", nonce });
});

test("classifier resolves auth.json through PI_CODING_AGENT_DIR before any live request", () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-native-agent-"));
	try {
		const missingDump = join(dir, "missing-prompt-dump.json");
		const result = spawnSync(process.execPath, ["--import", "tsx", BISECT, "auto", "--dump", missingDump], {
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: dir },
		});
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.ok(result.stderr.includes(join(dir, "auth.json")), result.stderr);
		assert.doesNotMatch(result.stderr, /getUserAgent is not defined/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
