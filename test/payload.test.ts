import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyBillingHeader,
	applyClaudeCodeBudgetThinkingProfile,
	applyClaudeCodeIdentity,
	applyClaudeCodeMaxTokens,
	applyClaudeCodeThinkingDisplay,
	applyContextManagement,
	applyDiagnostics,
	applyMetadata,
	sanitizeSystemPrompt,
} from "../src/payload.ts";

const VERSION = "2.1.87";
const ENTRYPOINT = "cli";
const BILLING_RE = /^x-anthropic-billing-header: cc_version=2\.1\.87\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/;

function basePayload() {
	return {
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: "say hello" }],
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text: "pi system prompt" },
		],
	};
}

test("prepends the billing header as system[0], keeping identity + prompt", () => {
	const result = applyBillingHeader(basePayload(), VERSION, ENTRYPOINT) as {
		system: Array<{ type: string; text: string }>;
	};

	assert.equal(result.system.length, 3);
	assert.match(result.system[0].text, BILLING_RE);
	assert.equal(result.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
	assert.equal(result.system[2].text, "pi system prompt");
});

test("a prompt-scoped billing header carries the captured TUI turn origin", () => {
	const result = applyBillingHeader(basePayload(), VERSION, "cli", "session-a") as {
		system: Array<{ text: string }>;
	};
	assert.match(result.system[0].text, / cc_prompt_id=[0-9a-f-]+; cc_turn_origin=human;$/);
});

test("does not mutate the original payload", () => {
	const payload = basePayload();
	applyBillingHeader(payload, VERSION, ENTRYPOINT);
	assert.equal(payload.system.length, 2);
	assert.equal(payload.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
});

test("is idempotent — running twice does not double-inject", () => {
	const once = applyBillingHeader(basePayload(), VERSION, ENTRYPOINT);
	const twice = applyBillingHeader(once, VERSION, ENTRYPOINT);
	assert.equal(twice, once); // same reference, no change
	assert.equal((twice as { system: unknown[] }).system.length, 3);
});

test("normalizes a string system field into blocks", () => {
	const result = applyBillingHeader(
		{ messages: [{ role: "user", content: "hi" }], system: "plain string prompt" },
		VERSION,
		ENTRYPOINT,
	) as { system: Array<{ type: string; text: string }> };

	assert.equal(result.system.length, 2);
	assert.match(result.system[0].text, BILLING_RE);
	assert.equal(result.system[1].text, "plain string prompt");
});

test("handles a missing system field", () => {
	const result = applyBillingHeader(
		{ messages: [{ role: "user", content: "hi" }] },
		VERSION,
		ENTRYPOINT,
	) as { system: Array<{ type: string; text: string }> };

	assert.equal(result.system.length, 1);
	assert.match(result.system[0].text, BILLING_RE);
});

test("returns the payload unchanged when there is no user message", () => {
	const payload = { messages: [{ role: "assistant", content: "hi" }], system: [] as unknown[] };
	const result = applyBillingHeader(payload, VERSION, ENTRYPOINT);
	assert.equal(result, payload); // same reference
});

test("ignores non-object payloads", () => {
	assert.equal(applyBillingHeader(undefined, VERSION, ENTRYPOINT), undefined);
	assert.equal(applyBillingHeader("nope", VERSION, ENTRYPOINT), "nope");
});

const RULES = {
	removeAnchors: ["Pi documentation (read only when"],
	replacements: [{ match: "operating inside pi, a coding agent harness", replacement: "operating in a command-line coding environment" }],
};

test("sanitizeSystemPrompt rewrites fingerprint phrases in system text blocks", () => {
	const payload = {
		messages: [{ role: "user", content: "hi" }],
		system: [
			{ type: "text", text: "You are an expert coding assistant operating inside pi, a coding agent harness." },
			{ type: "text", text: "unrelated block" },
		],
	};
	const result = sanitizeSystemPrompt(payload, RULES) as { system: Array<{ text: string }> };
	assert.equal(result.system[0].text, "You are an expert coding assistant operating in a command-line coding environment.");
	assert.equal(result.system[1].text, "unrelated block");
});

test("sanitizeSystemPrompt drops the whole anchored paragraph, keeping its neighbours", () => {
	const text = [
		"You help users by reading files.",
		"Pi documentation (read only when the user asks about pi):\n- docs: README.md\n- custom providers, adding models, SDK, packages",
		"<project_context>\nProject-specific instructions",
	].join("\n\n");
	const result = sanitizeSystemPrompt({ system: [{ type: "text", text }] }, RULES) as { system: Array<{ text: string }> };
	assert.ok(!result.system[0].text.includes("Pi documentation"));
	assert.ok(!result.system[0].text.includes("custom providers"));
	assert.equal(result.system[0].text, "You help users by reading files.\n\n<project_context>\nProject-specific instructions");
});

test("sanitizeSystemPrompt does not touch the billing header block and returns identity on no match", () => {
	const billing = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.87.abc; cc_entrypoint=cli; cch=12345;" };
	const payload = { system: [billing, { type: "text", text: "nothing to change here" }] };
	assert.equal(sanitizeSystemPrompt(payload, RULES), payload); // same reference, no change
	// even if a rule would match the billing prefix, it is skipped
	const onBilling = sanitizeSystemPrompt({ system: [billing] }, { replacements: [{ match: "x-anthropic", replacement: "X" }] });
	assert.equal((onBilling as { system: Array<{ text: string }> }).system[0].text, billing.text);
});

test("sanitizeSystemPrompt is a no-op with no rules or non-object payloads", () => {
	const payload = { system: [{ type: "text", text: "operating inside pi, a coding agent harness" }] };
	assert.equal(sanitizeSystemPrompt(payload, {}), payload);
	assert.equal(sanitizeSystemPrompt(undefined, RULES), undefined);
});

test("applyMetadata sets metadata.user_id and is idempotent / skips when absent", () => {
	const uid = '{"device_id":"abc","account_uuid":"u","session_id":"s"}';
	const result = applyMetadata({ model: "x" }, uid) as { metadata: { user_id: string } };
	assert.equal(result.metadata.user_id, uid);
	// already present → unchanged reference
	assert.equal(applyMetadata(result, "other"), result);
	// no id → unchanged reference
	const p = { model: "x" };
	assert.equal(applyMetadata(p, undefined), p);
});

test("Claude Code max_tokens clamps Pi's catalog ceiling but preserves smaller values", () => {
	const payload = { model: "claude-opus-5", max_tokens: 128_000, messages: [] };
	const result = applyClaudeCodeMaxTokens(payload, 64_000) as { max_tokens: number };
	assert.equal(result.max_tokens, 64_000);
	assert.equal(payload.max_tokens, 128_000, "input is not mutated");
	assert.equal(applyClaudeCodeMaxTokens(result, 64_000), result, "idempotent at the captured cap");

	const smaller = { max_tokens: 8_192 };
	assert.equal(applyClaudeCodeMaxTokens(smaller, 64_000), smaller, "explicit smaller caps survive");
	assert.deepEqual(applyClaudeCodeMaxTokens({}, 32_000), { max_tokens: 32_000 });
	assert.equal(applyClaudeCodeMaxTokens(payload, undefined), payload, "unknown models remain untouched");
	assert.equal(applyClaudeCodeMaxTokens(undefined, 64_000), undefined);
});

test("Claude identity alignment rewrites only exact first-party identities and is idempotent", () => {
	const codeIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
	const sdkIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
	const nearMatch = `${codeIdentity} `;
	const payload = {
		system: [
			{ type: "text", text: codeIdentity, cache_control: { type: "ephemeral" } },
			{ type: "text", text: nearMatch },
			{ type: "text", text: "custom system prompt" },
			{ type: "image", source: "untouched" },
		],
		messages: [],
	};

	const sdk = applyClaudeCodeIdentity(payload, sdkIdentity) as typeof payload;
	assert.notEqual(sdk, payload);
	assert.equal(payload.system[0].text, codeIdentity, "input is not mutated");
	assert.deepEqual(sdk.system, [
		{ type: "text", text: sdkIdentity, cache_control: { type: "ephemeral" } },
		{ type: "text", text: nearMatch },
		{ type: "text", text: "custom system prompt" },
		{ type: "image", source: "untouched" },
	]);
	assert.equal(applyClaudeCodeIdentity(sdk, sdkIdentity), sdk, "same target is idempotent");

	const code = applyClaudeCodeIdentity(sdk, codeIdentity) as typeof payload;
	assert.equal(code.system[0].text, codeIdentity, "both genuine identities are replaceable");
	assert.equal(applyClaudeCodeIdentity(code, codeIdentity), code);
	assert.equal(applyClaudeCodeIdentity(payload, "custom system prompt"), payload, "arbitrary targets are rejected");
	const unrelated = { system: [{ type: "text", text: "You are Claude Code-ish." }] };
	assert.equal(applyClaudeCodeIdentity(unrelated, sdkIdentity), unrelated, "near-matching source text is untouched");
});

test("interactive thinking uses display updates for adaptive and budget modes", () => {
	for (const thinking of [
		{ type: "adaptive", display: "summarized" },
		{ type: "enabled", display: "summarized", budget_tokens: 1024 },
	]) {
		const payload = { thinking, messages: [] };
		const result = applyClaudeCodeThinkingDisplay(payload, "updates") as typeof payload;
		assert.equal(result.thinking.display, "updates");
		assert.equal(thinking.display, "summarized", "input is not mutated");
		assert.equal(applyClaudeCodeThinkingDisplay(result, "updates"), result, "interactive alignment is idempotent");
	}
});

test("adaptive thinking uses Claude Code's omitted display without mutating the payload", () => {
	const payload = { thinking: { type: "adaptive", display: "summarized" }, messages: [] };
	const result = applyClaudeCodeThinkingDisplay(payload) as { thinking: { type: string; display: string } };
	assert.deepEqual(result.thinking, { type: "adaptive", display: "omitted" });
	assert.equal(payload.thinking.display, "summarized");
	assert.equal(applyClaudeCodeThinkingDisplay(result), result, "idempotent");
});

test("budget thinking also uses Claude Code's omitted display", () => {
	const budget = { thinking: { type: "enabled", display: "summarized", budget_tokens: 1024 } };
	const result = applyClaudeCodeThinkingDisplay(budget) as { thinking: { display: string; budget_tokens: number } };
	assert.deepEqual(result.thinking, { type: "enabled", display: "omitted", budget_tokens: 1024 });
	assert.equal(budget.thinking.display, "summarized");
	const disabled = { thinking: { type: "disabled" } };
	assert.equal(applyClaudeCodeThinkingDisplay(disabled), disabled);
	const malformed = { thinking: "adaptive" };
	assert.equal(applyClaudeCodeThinkingDisplay(malformed), malformed);
	assert.equal(applyClaudeCodeThinkingDisplay(undefined), undefined);
});

test("budget-thinking profiles align budget and Opus 4.5 effort without mutation", () => {
	const payload = {
		thinking: { type: "enabled", display: "updates", budget_tokens: 16_384 },
		output_config: { effort: "max", preserve: true },
		messages: [],
	};
	const result = applyClaudeCodeBudgetThinkingProfile(payload, {
		budgetTokens: 31_999,
		effort: "high",
	}) as typeof payload;

	assert.deepEqual(result.thinking, { type: "enabled", display: "updates", budget_tokens: 31_999 });
	assert.deepEqual(result.output_config, { effort: "high", preserve: true });
	assert.deepEqual(payload.thinking, { type: "enabled", display: "updates", budget_tokens: 16_384 });
	assert.deepEqual(payload.output_config, { effort: "max", preserve: true });
	assert.equal(
		applyClaudeCodeBudgetThinkingProfile(result, { budgetTokens: 31_999, effort: "high" }),
		result,
		"an aligned request is returned by reference",
	);
});

test("budget-thinking profiles leave adaptive thinking and missing profiles unchanged", () => {
	const adaptive = { thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } };
	const budget = { thinking: { type: "enabled", budget_tokens: 32_000 } };

	assert.equal(
		applyClaudeCodeBudgetThinkingProfile(adaptive, { budgetTokens: 31_999, effort: "high" }),
		adaptive,
	);
	assert.equal(applyClaudeCodeBudgetThinkingProfile(budget, undefined), budget);
});

test("a budget-thinking profile is a no-op when caller max_tokens cannot fit its budget", () => {
	for (const maxTokens of [31_999, 8_192]) {
		const payload = {
			max_tokens: maxTokens,
			thinking: { type: "enabled", budget_tokens: 1_024 },
			output_config: { effort: "max" },
		};
		assert.equal(
			applyClaudeCodeBudgetThinkingProfile(payload, { budgetTokens: 31_999, effort: "high" }),
			payload,
			`max_tokens=${maxTokens} remains untouched`,
		);
	}
});

test("a budget-thinking profile preserves an explicit lower reasoning level", () => {
	const payload = {
		max_tokens: 32_000,
		thinking: { type: "enabled", budget_tokens: 8_192 },
		output_config: { effort: "medium" },
	};
	assert.equal(
		applyClaudeCodeBudgetThinkingProfile(payload, { budgetTokens: 31_999, effort: "high" }),
		payload,
	);
});

test("applyContextManagement injects the field for enabled thinking and is idempotent", () => {
	const payload = { model: "x", thinking: { type: "enabled" }, messages: [] };
	const result = applyContextManagement(payload) as { context_management: unknown };
	assert.deepEqual(result.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
	assert.equal((payload as { context_management?: unknown }).context_management, undefined, "input is not mutated");
	const adaptive = applyContextManagement({ model: "x", thinking: { type: "adaptive" }, messages: [] }) as {
		context_management: unknown;
	};
	assert.deepEqual(adaptive.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
	// idempotent — returns same reference
	assert.equal(applyContextManagement(result), result);
	// non-object passthrough
	assert.equal(applyContextManagement(undefined), undefined);
	assert.equal(applyContextManagement(null), null);
});

test("applyContextManagement merges the clear edit into an existing valid context policy", () => {
	const payload = {
		model: "x",
		thinking: { type: "adaptive" },
		context_management: {
			keep_top_level: true,
			edits: [{ type: "compact_context_20300101", keep: "recent" }],
		},
	};
	const result = applyContextManagement(payload) as typeof payload;
	assert.deepEqual(result.context_management, {
		keep_top_level: true,
		edits: [
			{ type: "compact_context_20300101", keep: "recent" },
			{ type: "clear_thinking_20251015", keep: "all" },
		],
	});
	assert.equal(payload.context_management.edits.length, 1, "input is not mutated");
	assert.equal(applyContextManagement(result), result, "the merged policy is idempotent");

	const withoutEdits = { thinking: { type: "enabled" }, context_management: { strategy: "custom" } };
	assert.deepEqual(applyContextManagement(withoutEdits), {
		thinking: { type: "enabled" },
		context_management: { strategy: "custom", edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
	});
});

test("applyContextManagement does not add the clear-thinking edit when thinking is absent or disabled", () => {
	for (const payload of [
		{ model: "x", messages: [] },
		{ model: "x", thinking: { type: "disabled" }, messages: [] },
	]) {
		assert.equal(applyContextManagement(payload), payload);
		assert.equal("context_management" in payload, false);
	}
});

test("applyContextManagement removes only an incompatible clear edit and preserves other edits", () => {
	const payload = {
		model: "x",
		thinking: { type: "disabled" },
		context_management: {
			keep_top_level: true,
			edits: [
				{ type: "clear_thinking_20251015", keep: "all" },
				{ type: "compact_context_20260101", keep: "recent" },
			],
		},
	};
	const result = applyContextManagement(payload) as typeof payload;
	assert.deepEqual(result.context_management, {
		keep_top_level: true,
		edits: [{ type: "compact_context_20260101", keep: "recent" }],
	});
	assert.deepEqual(payload.context_management.edits, [
		{ type: "clear_thinking_20251015", keep: "all" },
		{ type: "compact_context_20260101", keep: "recent" },
	]);
	assert.equal(applyContextManagement(result), result, "idempotent after removing the incompatible edit");

	const absentThinking = {
		context_management: { edits: [{ type: "clear_thinking_20251015" }] },
	};
	const cleaned = applyContextManagement(absentThinking) as typeof absentThinking;
	assert.deepEqual(cleaned.context_management, { edits: [] });
});

test("applyDiagnostics injects the field and is idempotent", () => {
	const payload = { model: "x", messages: [] };
	const result = applyDiagnostics(payload) as { diagnostics: unknown };
	assert.deepEqual(result.diagnostics, { previous_message_id: null });
	// idempotent — returns same reference
	assert.equal(applyDiagnostics(result), result);
	// non-object passthrough
	assert.equal(applyDiagnostics(undefined), undefined);
});

test("applyClaudeCodeMaxTokens never clamps below an already-committed thinking budget", () => {
	// Regression: the clamp looked only at max_tokens. Anthropic requires
	// budget_tokens < max_tokens, and Pi sizes the budget against ITS max_tokens
	// before this hook runs, so lowering the cap underneath a large user-chosen
	// budget turned a working request into a hard 400.
	const withBudget = (maxTokens: number, budget: number) => ({
		model: "claude-sonnet-4-5",
		max_tokens: maxTokens,
		thinking: { type: "enabled", budget_tokens: budget },
	});

	// budget (40000) exceeds the captured cap (32000) → leave the payload alone.
	const risky = withBudget(64_000, 40_000);
	assert.equal(applyClaudeCodeMaxTokens(risky, 32_000), risky, "returns the original reference, untouched");

	// budget exactly equal to the cap is just as invalid.
	const equal = withBudget(64_000, 32_000);
	assert.equal(applyClaudeCodeMaxTokens(equal, 32_000), equal);

	// A budget that still fits is clamped as before, and stays valid.
	const fine = applyClaudeCodeMaxTokens(withBudget(64_000, 16_384), 32_000) as {
		max_tokens: number;
		thinking: { budget_tokens: number };
	};
	assert.equal(fine.max_tokens, 32_000);
	assert.ok(fine.thinking.budget_tokens < fine.max_tokens, "budget_tokens must stay below max_tokens");

	// Adaptive thinking carries no budget and is unaffected.
	const adaptive = { model: "claude-opus-5", max_tokens: 128_000, thinking: { type: "adaptive" } };
	assert.equal((applyClaudeCodeMaxTokens(adaptive, 64_000) as { max_tokens: number }).max_tokens, 64_000);
});
