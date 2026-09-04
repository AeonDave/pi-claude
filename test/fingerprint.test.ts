import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

test("a captured per-model beta set is used verbatim, preserving the genuine flag order", async () => {
	// Genuine Haiku does NOT order its flags like the base set — it sends
	// claude-code-20250219 sixth, not first. Filtering the base can only ever
	// produce the base's order, so a captured set has to win outright. This is
	// what lets a re-capture make a NEW model exact with no code change.
	const haiku = "oauth-2025-04-20,interleaved-thinking-2025-05-14,claude-code-20250219";
	const constants = await withFingerprint(
		JSON.stringify({ version: "2.1.261", anthropicBeta: "a,b,c", modelBeta: { "claude-haiku-4-5": haiku } }),
	);
	assert.equal(constants.getAnthropicBetaForModel("claude-haiku-4-5"), haiku);
	// A model absent from the map still resolves through the base set + deltas.
	assert.equal(constants.getAnthropicBetaForModel("claude-opus-5"), "a,b,c");
});

test("an explicit env override outranks a captured per-model set", async () => {
	const constants = await withFingerprint(
		JSON.stringify({ version: "2.1.261", anthropicBeta: "a,b", modelBeta: { "claude-opus-5": "captured" } }),
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
	const constants = await withFingerprint(
		'{"version": 2.1261, "anthropicBeta": ["a","b"], "entrypoint": 7, "modelBeta": "nope"}',
	);
	assert.equal(constants.getClaudeCodeVersion(), "2.1.261", "falls back past the invalid pin");
	assert.equal(constants.getClaudeCodeEntrypoint(), "sdk-cli");
	assert.equal(constants.getAnthropicBetaForModel("claude-opus-5"), constants.DEFAULT_ANTHROPIC_BETA);
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
	const constants = await withFingerprint(
		JSON.stringify({ version: "2.1.261", anthropicBeta: "a,b", modelBeta: { "claude-haiku-4-5-20251001": genuine } }),
	);
	assert.equal(constants.getAnthropicBetaForModel("claude-haiku-4-5"), genuine);
	assert.equal(constants.getAnthropicBetaForModel("claude-haiku-4-5-20251001"), genuine);
	assert.equal(constants.getAnthropicBetaForModel("claude-opus-5"), "a,b", "unrelated ids are untouched");
});

test("state lives under Pi's agent dir, and a pre-1.5.0 loose file is MOVED there", async () => {
	// Pi keeps every extension's state in `<agent dir>/<name>/` (auth.json,
	// settings.json, skill-optimizer/…). This extension used to drop loose
	// `claude-native-*.json` into `~/.pi/` instead. An existing install must not
	// merely keep reading the wrong place — the file gets relocated.
	const home = mkdtempSync(join(tmpdir(), "claude-native-home-"));
	const agentDir = join(home, ".pi", "agent");
	const legacy = join(home, ".pi", "claude-native-fingerprint.json");
	mkdirSync(join(home, ".pi"), { recursive: true });
	writeFileSync(legacy, JSON.stringify({ version: "2.1.261", anthropicBeta: "from-legacy" }), "utf8");

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
	mkdirSync(join(home, ".pi"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(home, ".pi", "claude-native-fingerprint.json"), JSON.stringify({ anthropicBeta: "old" }), "utf8");
	writeFileSync(join(stateDir, "fingerprint.json"), JSON.stringify({ anthropicBeta: "current" }), "utf8");

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
