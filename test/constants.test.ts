import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_ANTHROPIC_BETA,
	DEFAULT_NON_EFFORT_ANTHROPIC_BETA,
	getAnthropicBetaForModel,
} from "../src/constants.ts";

test("default beta set matches the Claude Code 2.1.233 Opus 5/Fable 5 capture", () => {
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
			(flag) => !["advisor-tool-2026-03-01", "effort-2025-11-24", "afk-mode-2026-01-31"].includes(flag),
		),
		"Haiku's capture omits only the three adaptive-effort flags",
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
