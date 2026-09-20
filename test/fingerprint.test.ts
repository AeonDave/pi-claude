import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coerceFingerprint } from "../src/fingerprint.ts";

/**
 * The fingerprint file is read once and memoized per process, so each case points
 * the env at a fresh file and drops the caches. (A cache-busting import query is
 * not enough: it would give a fresh `constants.ts` that still shares the one
 * `fingerprint.ts` instance holding the cache.)
 */
async function withFingerprint(contents: string): Promise<typeof import("../src/constants.ts")> {
	const dir = mkdtempSync(join(tmpdir(), "claude-native-fp-"));
	const path = join(dir, "fingerprint.json");
	writeFileSync(path, contents, "utf8");
	process.env.PI_CLAUDE_NATIVE_FINGERPRINT = path;
	(await import("../src/fingerprint.ts")).resetStateCaches();
	return await import("../src/constants.ts");
}

/** Re-read state after the surrounding test changed HOME / the env. */
async function reload(): Promise<typeof import("../src/constants.ts")> {
	(await import("../src/fingerprint.ts")).resetStateCaches();
	return await import("../src/constants.ts");
}

async function bundledVersion(): Promise<string> {
	return (await import("../src/constants.ts")).BUNDLED_CC_VERSION;
}

function nextPatchVersion(version: string): string {
	const parts = version.split(".").map(Number);
	assert.equal(parts.length, 3, `expected semver-like bundled version, got ${version}`);
	assert.ok(parts.every(Number.isInteger), `expected numeric bundled version, got ${version}`);
	parts[2] += 1;
	return parts.join(".");
}

test("fingerprint coercion keeps only valid per-model budget-thinking profiles", () => {
	const fingerprint = coerceFingerprint({
		modelBudgetThinking: {
			"claude-opus-4-5": { budgetTokens: 31_999, effort: "high" },
			"claude-sonnet-4-5": { budgetTokens: 31_999 },
			"bad-zero": { budgetTokens: 0, effort: "high" },
			"bad-fraction": { budgetTokens: 1.5 },
			"bad-effort": { budgetTokens: 31_999, effort: "ultracode" },
			"bad-shape": "enabled",
		},
	});

	assert.deepEqual(fingerprint?.modelBudgetThinking, {
		"claude-opus-4-5": { budgetTokens: 31_999, effort: "high" },
		"claude-sonnet-4-5": { budgetTokens: 31_999 },
	});
});

test("a captured per-model beta set is used verbatim, preserving the genuine flag order", async () => {
	// Genuine Haiku does NOT order its flags like the base set — it sends
	// claude-code-20250219 sixth, not first. Filtering the base can only ever
	// produce the base's order, so a captured set has to win outright. This is
	// what lets a re-capture make a NEW model exact with no code change.
	const haiku = "oauth-2025-04-20,interleaved-thinking-2025-05-14,claude-code-20250219";
	const currentVersion = await bundledVersion();
	const constants = await withFingerprint(
		JSON.stringify({
			version: currentVersion,
			anthropicBeta: "a,b,c",
			modelBeta: { "claude-haiku-4-5": haiku },
			modelMaxTokens: { "claude-haiku-4-5": 31_337 },
		}),
	);
	assert.equal(constants.getAnthropicBetaForModel("claude-haiku-4-5"), haiku);
	assert.equal(constants.getClaudeCodeMaxTokensForModel("claude-haiku-4-5"), 31_337);
	// A model absent from the map still resolves through the base set + deltas.
	assert.equal(constants.getAnthropicBetaForModel("claude-opus-5"), "a,b,c");
});

test("an explicit env override outranks a captured per-model set", async () => {
	const currentVersion = await bundledVersion();
	const constants = await withFingerprint(
		JSON.stringify({ version: currentVersion, anthropicBeta: "a,b", modelBeta: { "claude-opus-5": "captured" } }),
	);
	const previous = process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
	process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = "pinned-by-user";
	try {
		assert.equal(constants.getAnthropicBetaForModel("claude-opus-5"), "pinned-by-user");
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
		else process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = previous;
	}
});

test("a hand-edited fingerprint with wrong types degrades instead of crashing the session", async () => {
	// Regression: every field used to be trusted, so a non-string `version` threw
	// `version?.trim is not a function` at load and took the whole provider down.
	const home = mkdtempSync(join(tmpdir(), "claude-native-no-install-"));
	const saved = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		fingerprint: process.env.PI_CLAUDE_NATIVE_FINGERPRINT,
		version: process.env.PI_CLAUDE_NATIVE_CC_VERSION,
	};
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CLAUDE_NATIVE_CC_VERSION;
	try {
		const currentVersion = await bundledVersion();
		const constants = await withFingerprint(
			'{"version": 2.1261, "anthropicBeta": ["a","b"], "entrypoint": 7, "modelBeta": "nope", "modelMaxTokens": {"claude-opus-5": "64000"}}',
		);
		assert.deepEqual(
			constants.getClaudeCodeVersionInfo(),
			{ version: currentVersion, source: "default" },
			"falls back past the invalid pin without consulting host state",
		);
		assert.equal(constants.getClaudeCodeEntrypoint(), "sdk-cli");
		assert.equal(constants.getAnthropicBeta(), constants.DEFAULT_ANTHROPIC_BETA);
		assert.equal(constants.getClaudeCodeMaxTokensForModel("claude-opus-5"), 64_000);
	} finally {
		for (const [key, value] of [
			["HOME", saved.HOME],
			["USERPROFILE", saved.USERPROFILE],
			["PI_CLAUDE_NATIVE_FINGERPRINT", saved.fingerprint],
			["PI_CLAUDE_NATIVE_CC_VERSION", saved.version],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		(await import("../src/fingerprint.ts")).resetStateCaches();
	}
});

test("a malformed fingerprint file is ignored entirely", async () => {
	const constants = await withFingerprint("{ this is not json");
	assert.equal(constants.getAnthropicBeta(), constants.DEFAULT_ANTHROPIC_BETA);
	assert.match(constants.getUserAgent(), /^claude-cli\/\d+\.\d+\.\d+ \(external, sdk-cli\)$/);
});

test("live discovery is on by default and opt-out-able", async () => {
	const constants = await withFingerprint("{}");
	const previous = process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY;
	try {
		delete process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY;
		assert.equal(constants.isLiveDiscoveryEnabled(), true, "new models must appear without a code change");
		for (const off of ["0", "false", "no", "off", "OFF"]) {
			process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY = off;
			assert.equal(constants.isLiveDiscoveryEnabled(), false, `${off} disables discovery`);
		}
		process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY = "1";
		assert.equal(constants.isLiveDiscoveryEnabled(), true);
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY;
		else process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY = previous;
	}
});

test("a captured dated wire id also matches the clean alias the provider registers", async () => {
	// Genuine Claude Code sends `claude-haiku-4-5-20251001`; this provider registers
	// `claude-haiku-4-5`. Without matching both spellings the captured set — and the
	// genuine flag ORDER it exists to preserve — would never reach the wire.
	const genuine = "oauth-2025-04-20,interleaved-thinking-2025-05-14,claude-code-20250219";
	const currentVersion = await bundledVersion();
	const constants = await withFingerprint(
		JSON.stringify({
			version: currentVersion,
			anthropicBeta: "a,b",
			modelBeta: { "claude-haiku-4-5-20251001": genuine },
			modelMaxTokens: { "claude-haiku-4-5-20251001": 31_999 },
		}),
	);
	assert.equal(constants.getAnthropicBetaForModel("claude-haiku-4-5"), genuine);
	assert.equal(constants.getAnthropicBetaForModel("claude-haiku-4-5-20251001"), genuine);
	assert.equal(constants.getAnthropicBetaForModel("claude-opus-5"), "a,b", "unrelated ids are untouched");
	assert.equal(constants.getClaudeCodeMaxTokensForModel("claude-haiku-4-5"), 31_999);
	assert.equal(constants.getClaudeCodeMaxTokensForModel("claude-haiku-4-5-20251001"), 31_999);
});

test("a fingerprint older than the bundled capture cannot mask newer per-model defaults", async () => {
	// Claude 2.1.266 falsified the old assumption that a captured beta set remains
	// byte-identical forever: Opus 5 gained a flag while Sonnet 5 did not. A stale
	// 2.1.261 file must therefore lose to the newer bundled evidence as a whole.
	const constants = await withFingerprint(
		JSON.stringify({
			version: "2.1.261",
			entrypoint: "stale-entrypoint",
			anthropicBeta: "stale-base",
			modelBeta: { "claude-opus-5": "stale-model-set" },
			modelMaxTokens: { "claude-opus-5": 1 },
		}),
	);
	assert.equal(constants.getAnthropicBeta(), constants.DEFAULT_ANTHROPIC_BETA);
	assert.ok(constants.getAnthropicBetaForModel("claude-opus-5").includes("mid-conversation-tool-changes-2026-07-01"));
	assert.equal(constants.getClaudeCodeEntrypoint(), "sdk-cli");
	assert.equal(constants.getClaudeCodeMaxTokensForModel("claude-opus-5"), 64_000);
	assert.ok(constants.compareVersions(constants.getClaudeCodeVersion(), await bundledVersion()) >= 0);
});

test("a versionless fingerprint cannot bypass the bundled freshness floor", async () => {
	const constants = await withFingerprint(
		JSON.stringify({
			entrypoint: "cli",
			anthropicBeta: "unversioned-stale-base",
			modelBeta: { "claude-opus-5": "unversioned-stale-model" },
			modelMaxTokens: { "claude-opus-5": 1 },
		}),
	);
	assert.equal(constants.getAnthropicBeta(), constants.DEFAULT_ANTHROPIC_BETA);
	assert.equal(constants.getClaudeCodeEntrypoint(), "sdk-cli");
	assert.equal(constants.getClaudeCodeMaxTokensForModel("claude-opus-5"), 64_000);
});

test("a newer partial fingerprint never composes its common beta with older bundled model evidence", async () => {
	const midConversation = "mid-conversation-system-2026-04-07";
	const advanced = "advanced-tool-use-2025-11-20";
	const effort = "effort-2025-11-24";
	const binding = "thinking-binding-controls-2026-08-01";
	const displayUpdates = "thinking-display-updates-2026-08-18";
	const futureBase = ["future-common-a", midConversation, advanced, effort, binding, "future-common-z"];
	const saved = {
		fingerprint: process.env.PI_CLAUDE_NATIVE_FINGERPRINT,
		beta: process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA,
		entrypoint: process.env.PI_CLAUDE_NATIVE_CC_ENTRYPOINT,
	};
	delete process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
	delete process.env.PI_CLAUDE_NATIVE_CC_ENTRYPOINT;
	try {
		const futureVersion = nextPatchVersion(await bundledVersion());
		const constants = await withFingerprint(
			JSON.stringify({
				version: futureVersion,
				anthropicBeta: futureBase.join(","),
				modelBeta: {
					"claude-opus-5": [...futureBase, "future-opus-only"].join(","),
					"claude-sonnet-5": futureBase.join(","),
				},
			}),
		);
		const expectedTui = ["future-common-a", midConversation, advanced, effort, binding, displayUpdates, "future-common-z"];
		for (const id of ["claude-opus-4-7", "claude-fable-5"]) {
			assert.deepEqual(
				constants.getAnthropicBetaForModel(id, "print").split(","),
				futureBase,
				`${id}: no bundled model delta is composed with a ${futureVersion} base`,
			);
			const tui = constants.getAnthropicBetaForModel(id, "tui").split(",");
			assert.deepEqual(tui, expectedTui, `${id}: TUI adds only its mode-wide signal`);
			assert.equal(tui.includes("fallback-credit-2026-06-01"), false, `${id}: no bundled TUI exception`);
			assert.equal(tui.includes("mid-conversation-tool-changes-2026-07-01"), false, `${id}: no bundled addition`);
		}
	} finally {
		for (const [key, value] of [
			["PI_CLAUDE_NATIVE_FINGERPRINT", saved.fingerprint],
			["PI_CLAUDE_NATIVE_ANTHROPIC_BETA", saved.beta],
			["PI_CLAUDE_NATIVE_CC_ENTRYPOINT", saved.entrypoint],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		(await import("../src/fingerprint.ts")).resetStateCaches();
	}
});

test("a newer fingerprint with only modelBeta does not apply bundled deltas to an omitted id", async () => {
	const saved = {
		fingerprint: process.env.PI_CLAUDE_NATIVE_FINGERPRINT,
		beta: process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA,
	};
	delete process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
	try {
		const futureVersion = nextPatchVersion(await bundledVersion());
		const constants = await withFingerprint(
			JSON.stringify({
				version: futureVersion,
				modelBeta: { "claude-opus-5": "future-opus-only" },
			}),
		);
		assert.equal(constants.getAnthropicBetaForModel("claude-opus-5", "print"), "future-opus-only");
		assert.equal(
			constants.getAnthropicBetaForModel("claude-opus-4-7", "print"),
			constants.DEFAULT_ANTHROPIC_BETA,
			"the omitted id keeps the common fallback instead of inheriting a bundled removal",
		);
	} finally {
		if (saved.fingerprint === undefined) delete process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
		else process.env.PI_CLAUDE_NATIVE_FINGERPRINT = saved.fingerprint;
		if (saved.beta === undefined) delete process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
		else process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = saved.beta;
		(await import("../src/fingerprint.ts")).resetStateCaches();
	}
});

test("a newer fingerprint uses captured budget thinking but never fills an omitted profile from bundled data", async () => {
	const savedFingerprint = process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
	try {
		const futureVersion = nextPatchVersion(await bundledVersion());
		const constants = await withFingerprint(
			JSON.stringify({
				version: futureVersion,
				modelBudgetThinking: {
					"claude-opus-4-5": { budgetTokens: 30_123, effort: "xhigh" },
				},
			}),
		);
		assert.deepEqual(constants.getClaudeCodeBudgetThinkingProfileForModel("claude-opus-4-5"), {
			budgetTokens: 30_123,
			effort: "xhigh",
		});
		assert.equal(
			constants.getClaudeCodeBudgetThinkingProfileForModel("claude-sonnet-4-5"),
			undefined,
			`an omitted ${futureVersion} id cannot inherit its bundled ${await bundledVersion()} profile`,
		);
	} finally {
		if (savedFingerprint === undefined) delete process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
		else process.env.PI_CLAUDE_NATIVE_FINGERPRINT = savedFingerprint;
		(await import("../src/fingerprint.ts")).resetStateCaches();
	}
});

test("a newer partial fingerprint leaves uncaptured max_tokens alone but applies an explicit captured cap", async () => {
	const savedFingerprint = process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
	try {
		const futureVersion = nextPatchVersion(await bundledVersion());
		const constants = await withFingerprint(
			JSON.stringify({
				version: futureVersion,
				anthropicBeta: "future-common",
				modelMaxTokens: { "claude-opus-5": 63_001 },
			}),
		);
		const { applyClaudeCodeMaxTokens } = await import("../src/payload.ts");

		const uncaptured = { model: "claude-fable-5", max_tokens: 128_000, messages: [] };
		const missingCap = constants.getClaudeCodeMaxTokensForModel(uncaptured.model);
		assert.equal(
			missingCap,
			undefined,
			`${futureVersion} fingerprint cannot inherit a bundled ${await bundledVersion()} cap`,
		);
		assert.equal(applyClaudeCodeMaxTokens(uncaptured, missingCap), uncaptured, "the serialized payload remains untouched");

		const captured = { model: "claude-opus-5", max_tokens: 128_000, messages: [] };
		const capturedCap = constants.getClaudeCodeMaxTokensForModel(captured.model);
		assert.equal(capturedCap, 63_001);
		const clamped = applyClaudeCodeMaxTokens(captured, capturedCap) as typeof captured;
		assert.equal(clamped.max_tokens, 63_001, "the explicitly captured cap still applies");
		assert.equal(captured.max_tokens, 128_000, "the input payload is not mutated");
	} finally {
		if (savedFingerprint === undefined) delete process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
		else process.env.PI_CLAUDE_NATIVE_FINGERPRINT = savedFingerprint;
		(await import("../src/fingerprint.ts")).resetStateCaches();
	}
});

test("state lives under Pi's agent dir, and a pre-1.5.0 loose file is MOVED there", async () => {
	// Pi keeps every extension's state in `<agent dir>/<name>/` (auth.json,
	// settings.json, skill-optimizer/…). This extension used to drop loose
	// `claude-native-*.json` into `~/.pi/` instead. An existing install must not
	// merely keep reading the wrong place — the file gets relocated.
	const home = mkdtempSync(join(tmpdir(), "claude-native-home-"));
	const agentDir = join(home, ".pi", "agent");
	const legacy = join(home, ".pi", "claude-native-fingerprint.json");
	const currentVersion = await bundledVersion();
	mkdirSync(join(home, ".pi"), { recursive: true });
	writeFileSync(legacy, JSON.stringify({ version: currentVersion, anthropicBeta: "from-legacy" }), "utf8");

	const saved = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		fp: process.env.PI_CLAUDE_NATIVE_FINGERPRINT,
		state: process.env.PI_CLAUDE_NATIVE_STATE_DIR,
		cache: process.env.PI_CLAUDE_NATIVE_MODELS_CACHE,
	};
	// os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
	delete process.env.PI_CLAUDE_NATIVE_STATE_DIR;
	delete process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
	try {
		const constants = await reload();
		assert.equal(constants.getAgentDir(), agentDir, "agent dir resolves like Pi's own getAgentDir()");
		assert.equal(constants.getStateDir(), join(agentDir, "claude-native"));
		assert.equal(constants.getFingerprintPath(), join(agentDir, "claude-native", "fingerprint.json"));

		constants.migrateLegacyState();

		const moved = join(agentDir, "claude-native", "fingerprint.json");
		assert.ok(existsSync(moved), "the fingerprint was moved onto the convention");
		assert.ok(!existsSync(legacy), "the loose file no longer lingers in ~/.pi");
		assert.equal(JSON.parse(readFileSync(moved, "utf8")).anthropicBeta, "from-legacy", "contents survive the move");
		// And it is still the value the extension resolves.
		assert.equal(constants.getAnthropicBeta(), "from-legacy");
	} finally {
		for (const [key, value] of [
			["HOME", saved.HOME],
			["USERPROFILE", saved.USERPROFILE],
			["PI_CLAUDE_NATIVE_FINGERPRINT", saved.fp],
			["PI_CLAUDE_NATIVE_STATE_DIR", saved.state],
			["PI_CLAUDE_NATIVE_MODELS_CACHE", saved.cache],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("migration never overwrites a file already at the current path", async () => {
	const home = mkdtempSync(join(tmpdir(), "claude-native-keep-"));
	const agentDir = join(home, ".pi", "agent");
	const stateDir = join(agentDir, "claude-native");
	const currentVersion = await bundledVersion();
	mkdirSync(join(home, ".pi"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(home, ".pi", "claude-native-fingerprint.json"),
		JSON.stringify({ version: currentVersion, anthropicBeta: "old" }),
		"utf8",
	);
	writeFileSync(
		join(stateDir, "fingerprint.json"),
		JSON.stringify({ version: currentVersion, anthropicBeta: "current" }),
		"utf8",
	);

	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, fp: process.env.PI_CLAUDE_NATIVE_FINGERPRINT };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CLAUDE_NATIVE_FINGERPRINT;
	try {
		const constants = await reload();
		constants.migrateLegacyState();
		assert.equal(JSON.parse(readFileSync(join(stateDir, "fingerprint.json"), "utf8")).anthropicBeta, "current");
		assert.equal(constants.getAnthropicBeta(), "current", "the current path always wins");
	} finally {
		for (const [key, value] of [
			["HOME", saved.HOME],
			["USERPROFILE", saved.USERPROFILE],
			["PI_CLAUDE_NATIVE_FINGERPRINT", saved.fp],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
