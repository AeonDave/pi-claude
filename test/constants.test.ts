import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolation: `getAnthropicBetaForModel` consults the fingerprint's per-model map,
// so a real capture on the developer's machine must not reach these assertions.
process.env.PI_CLAUDE_NATIVE_FINGERPRINT = join(tmpdir(), `claude-native-absent-fingerprint-${randomUUID()}.json`);

const {
	CLAUDE_AGENT_SDK_IDENTITY,
	CLAUDE_CODE_IDENTITY,
	BUNDLED_CC_VERSION,
	DEFAULT_ANTHROPIC_BETA,
	DEFAULT_BUDGET_THINKING_PROFILES,
	DEFAULT_MODEL_MAX_TOKENS,
	DEFAULT_NON_EFFORT_ANTHROPIC_BETA,
	MODEL_BETA_DELTAS,
	compareVersions,
	getAnthropicBetaForModel,
	getClaudeCodeEntrypoint,
	getClaudeCodeIdentity,
	getClaudeCodeBudgetThinkingProfileForModel,
	getClaudeCodeMaxTokensForModel,
	getClaudeCodeThinkingDisplay,
	getClaudeCodeVersion,
	getUserAgent,
	resolveClaudeCodeVersion,
} = await import("../src/constants.ts");

function nextPatch(version: string): string {
	const parts = version.split(".").map(Number);
	assert.equal(parts.length, 3);
	assert.ok(parts.every(Number.isInteger));
	parts[2] += 1;
	return parts.join(".");
}

function withEnvCleared(names: readonly string[], run: () => void): void {
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	try {
		run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("default beta set matches the bundled Opus/Sonnet common capture", () => {
	assert.deepEqual(DEFAULT_ANTHROPIC_BETA.split(","), [
		"claude-code-20250219",
		"oauth-2025-04-20",
		"interleaved-thinking-2025-05-14",
		"thinking-token-count-2026-05-13",
		"context-management-2025-06-27",
		"prompt-caching-scope-2026-01-05",
		"mid-conversation-system-2026-04-07",
		"advisor-tool-2026-03-01",
		"advanced-tool-use-2025-11-20",
		"effort-2025-11-24",
		"thinking-binding-controls-2026-08-01",
		"afk-mode-2026-01-31",
		"extended-cache-ttl-2025-04-11",
		"cache-diagnosis-2026-04-07",
	]);
	assert.ok(!DEFAULT_ANTHROPIC_BETA.includes("context-1m-2025-08-07"));
	assert.deepEqual(
		DEFAULT_NON_EFFORT_ANTHROPIC_BETA.split(","),
		DEFAULT_ANTHROPIC_BETA.split(",").filter(
			(flag) => !["mid-conversation-system-2026-04-07", "effort-2025-11-24", "afk-mode-2026-01-31"].includes(flag),
		),
		"the bundled Haiku capture omits mid-conversation-system, effort, and afk-mode",
	);
});

test("runtime modes select one internally coherent genuine Claude profile", () => {
	withEnvCleared(["PI_CLAUDE_NATIVE_CC_ENTRYPOINT", "PI_CLAUDE_NATIVE_USER_AGENT"], () => {
		const version = getClaudeCodeVersion();
		assert.deepEqual(
			{
				entrypoint: getClaudeCodeEntrypoint("tui"),
				userAgent: getUserAgent("tui"),
				identity: getClaudeCodeIdentity("tui"),
				display: getClaudeCodeThinkingDisplay("tui"),
			},
			{
				entrypoint: "cli",
				userAgent: `claude-cli/${version} (external, cli)`,
				identity: CLAUDE_CODE_IDENTITY,
				display: "updates",
			},
		);

		for (const mode of [undefined, "print", "json", "rpc"] as const) {
			assert.deepEqual(
				{
					entrypoint: getClaudeCodeEntrypoint(mode),
					userAgent: getUserAgent(mode),
					identity: getClaudeCodeIdentity(mode),
					display: getClaudeCodeThinkingDisplay(mode),
				},
				{
					entrypoint: "sdk-cli",
					userAgent: `claude-cli/${version} (external, sdk-cli)`,
					identity: CLAUDE_AGENT_SDK_IDENTITY,
					display: "omitted",
				},
				mode ?? "default",
			);
		}
	});
});

test("an explicit beta override remains verbatim on Haiku", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
	process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = "custom-beta,afk-mode-2026-01-31";
	try {
		assert.equal(getAnthropicBetaForModel("claude-haiku-4-5"), "custom-beta,afk-mode-2026-01-31");
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
		else process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = previous;
	}
});

test("bundled per-model additions match the captured clean models exactly", () => {
	const toolChanges = "mid-conversation-tool-changes-2026-07-01";
	const perTurn = "per-turn-control-2026-07-01";
	const midConvo = "mid-conversation-system-2026-04-07";
	const advisor = "advisor-tool-2026-03-01";
	const base = DEFAULT_ANTHROPIC_BETA.split(",");

	// Opus 5.5 and Fable 5.1 share the two-addition chain. The anchors lock the captured
	// order: mid-conversation-system → per-turn-control → tool-changes → advisor.
	for (const id of ["claude-opus-5-5", "claude-fable-5-1"]) {
		const flags = getAnthropicBetaForModel(id).split(",");
		assert.equal(flags.length, 16, id);
		assert.deepEqual(flags.slice(6, 10), [midConvo, perTurn, toolChanges, advisor], id);
		assert.deepEqual(flags.filter((flag) => flag !== perTurn && flag !== toolChanges), base, id);
	}

	// The new tool-change flag is exact-id scoped. These are the only other three
	// bundled captures carrying it, always directly after mid-conversation-system.
	for (const id of ["claude-opus-5", "claude-fable-5", "claude-opus-4-8"]) {
		const flags = getAnthropicBetaForModel(id).split(",");
		assert.equal(flags.length, 15, id);
		assert.deepEqual(flags.slice(6, 9), [midConvo, toolChanges, advisor], id);
		assert.deepEqual(flags.filter((flag) => flag !== toolChanges), base, id);
	}

	// Every remaining captured model keeps the already-known set.
	assert.equal(getAnthropicBetaForModel("claude-sonnet-5").split(",").length, 14);
	assert.equal(getAnthropicBetaForModel("claude-haiku-4-5").split(",").length, 11);
	assert.equal(getAnthropicBetaForModel("claude-sonnet-4-5").split(",").length, 11);
	assert.equal(getAnthropicBetaForModel("claude-opus-4-5").split(",").length, 12);
	for (const id of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
		assert.equal(getAnthropicBetaForModel(id).split(",").length, 13, id);
	}
	assert.deepEqual(
		Object.entries(MODEL_BETA_DELTAS)
			.filter(([, delta]) => (delta.add?.length ?? 0) > 0)
			.map(([id]) => id)
			.sort(),
		["claude-fable-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"],
		"only exact captured ids gain flags",
	);
});

test("TUI beta headers preserve the exact captured order for all twelve clean models", () => {
	withEnvCleared(["PI_CLAUDE_NATIVE_ANTHROPIC_BETA", "PI_CLAUDE_NATIVE_CC_ENTRYPOINT"], () => {
		const cc = "claude-code-20250219";
		const oauth = "oauth-2025-04-20";
		const interleaved = "interleaved-thinking-2025-05-14";
		const tokenCount = "thinking-token-count-2026-05-13";
		const context = "context-management-2025-06-27";
		const cacheScope = "prompt-caching-scope-2026-01-05";
		const midConversation = "mid-conversation-system-2026-04-07";
		const perTurn = "per-turn-control-2026-07-01";
		const toolChanges = "mid-conversation-tool-changes-2026-07-01";
		const advisor = "advisor-tool-2026-03-01";
		const advanced = "advanced-tool-use-2025-11-20";
		const effort = "effort-2025-11-24";
		const thinkingBinding = "thinking-binding-controls-2026-08-01";
		const displayUpdates = "thinking-display-updates-2026-08-18";
		const afk = "afk-mode-2026-01-31";
		const cacheTtl = "extended-cache-ttl-2025-04-11";
		const cacheDiagnosis = "cache-diagnosis-2026-04-07";

		const expected: Record<string, readonly string[]> = {
			"claude-opus-5-5": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, midConversation, perTurn,
				toolChanges, advisor, advanced, effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-opus-5": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, midConversation, toolChanges,
				advisor, advanced, effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-sonnet-5": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, midConversation, advisor,
				advanced, effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-fable-5-1": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, midConversation, perTurn,
				toolChanges, advisor, advanced, effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-fable-5": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, midConversation, toolChanges,
				advisor, advanced, effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-opus-4-8": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, midConversation, toolChanges,
				advisor, advanced, effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-opus-4-7": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, advisor, advanced,
				effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-opus-4-6": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, advisor, advanced,
				effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-sonnet-4-6": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, advisor, advanced,
				effort, thinkingBinding, displayUpdates, afk, cacheTtl, cacheDiagnosis,
			],
			"claude-opus-4-5": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, advisor, advanced,
				effort, thinkingBinding, displayUpdates, cacheTtl, cacheDiagnosis,
			],
			"claude-sonnet-4-5": [
				cc, oauth, interleaved, tokenCount, context, cacheScope, advisor, advanced,
				thinkingBinding, displayUpdates, cacheTtl, cacheDiagnosis,
			],
			// Haiku's wire order is genuinely different: claude-code is sixth.
			"claude-haiku-4-5": [
				oauth, interleaved, tokenCount, context, cacheScope, cc, advisor, advanced,
				thinkingBinding, displayUpdates, cacheTtl, cacheDiagnosis,
			],
		};

		assert.equal(Object.keys(expected).length, 12);
		for (const [id, flags] of Object.entries(expected)) {
			assert.deepEqual(getAnthropicBetaForModel(id, "tui").split(","), flags, id);
			assert.equal(flags.filter((flag) => flag === displayUpdates).length, 1, `${id}: one mode-wide signal`);
		}
		for (const [id, flags] of Object.entries(expected)) {
			assert.equal(flags.includes("fallback-credit-2026-06-01"), false, `${id}: stale fallback-credit must be absent`);
		}
	});
});

test("an unknown TUI family receives only the mode-wide beta signal", () => {
	withEnvCleared(["PI_CLAUDE_NATIVE_ANTHROPIC_BETA", "PI_CLAUDE_NATIVE_CC_ENTRYPOINT"], () => {
		const id = "claude-mythos-6";
		const displayUpdates = "thinking-display-updates-2026-08-18";
		const thinkingBinding = "thinking-binding-controls-2026-08-01";
		const nonInteractive = getAnthropicBetaForModel(id, "print").split(",");
		const interactive = getAnthropicBetaForModel(id, "tui").split(",");
		assert.deepEqual(interactive.filter((flag) => flag !== displayUpdates), nonInteractive);
		assert.equal(interactive.filter((flag) => flag === displayUpdates).length, 1);
		assert.equal(interactive.includes("fallback-credit-2026-06-01"), false, "stale fallback-credit is absent");
		assert.equal(interactive.indexOf(displayUpdates), interactive.indexOf(thinkingBinding) + 1);
	});
});

test("an unknown discovered budget model gets the non-effort base while adaptive keeps the full base", () => {
	withEnvCleared(["PI_CLAUDE_NATIVE_ANTHROPIC_BETA", "PI_CLAUDE_NATIVE_CC_ENTRYPOINT"], () => {
		const id = "claude-mythos-1";
		const displayUpdates = "thinking-display-updates-2026-08-18";
		const budget = getAnthropicBetaForModel(id, "print", false).split(",");
		const expectedBudget = DEFAULT_NON_EFFORT_ANTHROPIC_BETA.split(",");

		assert.deepEqual(budget, expectedBudget);
		for (const flag of [
			"mid-conversation-system-2026-04-07",
			"effort-2025-11-24",
			"afk-mode-2026-01-31",
		]) {
			assert.equal(budget.includes(flag), false, `${flag} is adaptive/effort-only`);
		}

		const tui = getAnthropicBetaForModel(id, "tui", false).split(",");
		assert.deepEqual(tui.filter((flag) => flag !== displayUpdates), expectedBudget);
		assert.equal(tui.filter((flag) => flag === displayUpdates).length, 1, "TUI adds only its mode-wide display signal");
		assert.deepEqual(getAnthropicBetaForModel(id, "print", true).split(","), DEFAULT_ANTHROPIC_BETA.split(","));
	});
});

test("bundled request max_tokens matches all twelve clean genuine captures", () => {
	const expected = {
		"claude-opus-5-5": 128_000,
		"claude-opus-5": 64_000,
		"claude-sonnet-5": 64_000,
		"claude-fable-5-1": 64_000,
		"claude-fable-5": 64_000,
		"claude-opus-4-8": 64_000,
		"claude-opus-4-7": 64_000,
		"claude-opus-4-6": 64_000,
		"claude-sonnet-4-6": 32_000,
		"claude-opus-4-5": 32_000,
		"claude-sonnet-4-5": 32_000,
		"claude-haiku-4-5": 32_000,
	};
	assert.deepEqual(DEFAULT_MODEL_MAX_TOKENS, expected);
	for (const [id, cap] of Object.entries(expected)) {
		assert.equal(getClaudeCodeMaxTokensForModel(id), cap, id);
	}
	assert.equal(getClaudeCodeMaxTokensForModel("claude-mythos-6"), undefined, "unknown ids are never guessed");
	assert.equal(getClaudeCodeMaxTokensForModel("claude-fable-5-2"), undefined, "an uncaptured future Fable cap is not extrapolated");
});

test("bundled budget-thinking profiles are limited to the three captured exact ids", () => {
	const expected = {
		"claude-opus-4-5": { budgetTokens: 31_999, effort: "high" },
		"claude-sonnet-4-5": { budgetTokens: 31_999 },
		"claude-haiku-4-5": { budgetTokens: 31_999 },
	};
	assert.deepEqual(DEFAULT_BUDGET_THINKING_PROFILES, expected);
	for (const [id, profile] of Object.entries(expected)) {
		assert.deepEqual(getClaudeCodeBudgetThinkingProfileForModel(id), profile, id);
	}
	assert.equal(
		getClaudeCodeBudgetThinkingProfileForModel("claude-mythos-6"),
		undefined,
		"unknown ids never inherit a budget profile",
	);
});

test("an explicit beta override stays verbatim even for a model with an addition", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
	process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = "only-this-flag";
	try {
		assert.equal(getAnthropicBetaForModel("claude-fable-5-1"), "only-this-flag");
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA;
		else process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA = previous;
	}
});

test("compareVersions orders releases numerically, not lexically", () => {
	assert.equal(compareVersions("2.1.261", "2.1.241") > 0, true);
	assert.equal(compareVersions("2.1.9", "2.1.10") < 0, true, "9 < 10 despite sorting after lexically");
	assert.equal(compareVersions("2.1.261", "2.1.261"), 0);
	assert.equal(compareVersions("2.2.0", "2.1.999") > 0, true);
});

test("a stale fingerprint never pins a version older than the installed claude", () => {
	// The 2.1.241 outage: the fingerprint outranked the installed claude, so the
	// client kept claiming a version below Anthropic's model gate, silently and
	// permanently.
	assert.deepEqual(resolveClaudeCodeVersion({ pinned: "2.1.241", installed: "2.1.261", fallback: "2.1.200" }), {
		version: "2.1.261",
		source: "installed",
	});
	// The bundled capture is also a floor. A stale on-disk fingerprint must not
	// downgrade a newer extension on a machine without Claude installed.
	assert.deepEqual(resolveClaudeCodeVersion({ pinned: "0.0.1", installed: null }), {
		version: BUNDLED_CC_VERSION,
		source: "default",
	});
	// A fingerprint NEWER than the install still wins — it is a real capture.
	const future = nextPatch(BUNDLED_CC_VERSION);
	assert.deepEqual(resolveClaudeCodeVersion({ pinned: future, installed: "2.1.261" }), {
		version: future,
		source: "fingerprint",
	});
	// An explicit env pin is honoured verbatim, in either direction.
	assert.deepEqual(resolveClaudeCodeVersion({ override: "2.0.0", pinned: "2.1.261", installed: "2.1.261" }), {
		version: "2.0.0",
		source: "env",
	});
	// A non-standard pin is a deliberate choice and is passed through untouched.
	assert.deepEqual(resolveClaudeCodeVersion({ pinned: "2.1.241-rc1", installed: "2.1.261" }), {
		version: "2.1.241-rc1",
		source: "fingerprint",
	});
	// No fingerprint, no install → the hardcoded floor.
	assert.equal(resolveClaudeCodeVersion({ fallback: "2.1.261" }).source, "default");
	assert.deepEqual(resolveClaudeCodeVersion({ installed: "2.1.261", fallback: "2.1.200" }), {
		version: "2.1.261",
		source: "installed",
	});
});
