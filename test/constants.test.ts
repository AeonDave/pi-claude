import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolation: `getAnthropicBetaForModel` consults the fingerprint's per-model map,
// so a real capture on the developer's machine must not reach these assertions.
process.env.PI_CLAUDE_NATIVE_FINGERPRINT = join(tmpdir(), `claude-native-absent-fingerprint-${randomUUID()}.json`);

const {
	DEFAULT_ANTHROPIC_BETA,
	DEFAULT_NON_EFFORT_ANTHROPIC_BETA,
	MODEL_BETA_DELTAS,
	compareVersions,
	getAnthropicBetaForModel,
	resolveClaudeCodeVersion,
} = await import("../src/constants.ts");

test("default beta set matches the Claude Code 2.1.261 Opus 5/Sonnet 5 capture", () => {
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
		"Haiku's 2.1.261 capture omits mid-conversation-system, effort, and afk-mode",
	);
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

test("Fable 5.1 gains per-turn-control at the captured position; no other model does", () => {
	// Genuine claude 2.1.261 (captures/fp-raw/req-fp-4.json) sends 14 flags for
	// claude-fable-5-1: the 13-flag base plus per-turn-control-2026-07-01 inserted
	// directly after mid-conversation-system-2026-04-07. Order is part of the
	// captured value, so the position is asserted, not just membership.
	const fable = getAnthropicBetaForModel("claude-fable-5-1").split(",");
	const base = DEFAULT_ANTHROPIC_BETA.split(",");
	assert.equal(fable.length, 14);
	assert.equal(fable.indexOf("per-turn-control-2026-07-01"), 7);
	assert.equal(fable[6], "mid-conversation-system-2026-04-07");
	assert.equal(fable[8], "advisor-tool-2026-03-01");
	assert.deepEqual(
		fable.filter((flag) => flag !== "per-turn-control-2026-07-01"),
		base,
		"the addition is the ONLY difference from the base set",
	);

	// Claude Code gates the flag on the model's per_turn_effort capability, and
	// claude-fable-5-1 is the only id that declares it. Sending it wider risks a
	// 400 on an unexpected beta, so every other model keeps its own set.
	assert.equal(getAnthropicBetaForModel("claude-fable-5").split(",").length, 13);
	assert.equal(getAnthropicBetaForModel("claude-opus-5").split(",").length, 13);
	assert.equal(getAnthropicBetaForModel("claude-sonnet-5").split(",").length, 13);
	assert.equal(getAnthropicBetaForModel("claude-haiku-4-5").split(",").length, 10);
	assert.deepEqual(
		Object.entries(MODEL_BETA_DELTAS)
			.filter(([, delta]) => delta.add)
			.map(([id]) => id),
		["claude-fable-5-1"],
		"only Fable 5.1 ADDS a flag",
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
	assert.deepEqual(resolveClaudeCodeVersion({ pinned: "2.1.241", installed: "2.1.261" }), {
		version: "2.1.261",
		source: "installed",
	});
	// A fingerprint NEWER than the install still wins — it is a real capture.
	assert.deepEqual(resolveClaudeCodeVersion({ pinned: "2.1.270", installed: "2.1.261" }), {
		version: "2.1.270",
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
	assert.deepEqual(resolveClaudeCodeVersion({ installed: "2.1.261" }), { version: "2.1.261", source: "installed" });
});
