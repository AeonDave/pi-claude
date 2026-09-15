import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertConsistentFingerprintCandidate,
	assertNoCanonicalModelDrift,
	assertNonInteractiveCaptureProfile,
	assertRequestedCapturesComplete,
	buildModelBeta,
	buildModelBudgetThinking,
	buildModelMaxTokens,
	computeBetaDeviations,
	DEFAULT_CAPTURE_MODELS,
	isCaptureProxyHealthResponse,
	isRequestedMainCapture,
	parseCaptureProfile,
	selectFingerprintBaseline,
	type FingerprintCandidate,
} from "../scripts/fingerprint-baseline.ts";

function candidate(
	wireModel: string,
	beta: string[],
	triggeredBy: string[],
	overrides: Partial<FingerprintCandidate> = {},
): FingerprintCandidate {
	return {
		wireModel,
		beta,
		triggeredBy,
		version: "2.1.266",
		entrypoint: "sdk-cli",
		userAgent: "claude-cli/2.1.266 (external, sdk-cli)",
		effort: "xhigh",
		maxTokens: 64_000,
		hasCch: true,
		identity: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
		thinkingDisplay: "omitted",
		has1mBeta: false,
		...overrides,
	};
}

test("default capture covers moving aliases before every currently exposed exact model id", () => {
	assert.deepEqual(DEFAULT_CAPTURE_MODELS, [
		"opus",
		"sonnet",
		"haiku",
		"fable",
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-fable-5-1",
		"claude-fable-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-opus-4-5",
		"claude-sonnet-4-5",
		"claude-haiku-4-5",
	]);
	assert.equal(DEFAULT_CAPTURE_MODELS.length, 15);
});

test("fingerprint baseline is the ordered intersection of bare Opus and Sonnet aliases", () => {
	const opus = candidate("claude-opus-5", ["base-a", "opus-only", "base-b"], ["opus"]);
	const sonnet = candidate("claude-sonnet-5", ["base-a", "base-b"], ["sonnet"]);
	const baseline = selectFingerprintBaseline([opus, sonnet]);

	assert.equal(baseline.opus, opus);
	assert.equal(baseline.sonnet, sonnet);
	assert.deepEqual(baseline.beta, ["base-a", "base-b"]);
});

test("an incomplete live capture is rejected before publish/apply", () => {
	assert.doesNotThrow(() =>
		assertRequestedCapturesComplete([
			{ model: "opus", captures: 1, mainCaptures: 1 },
			{ model: "sonnet", captures: 2, mainCaptures: 1 },
		]),
	);
	assert.throws(
		() =>
			assertRequestedCapturesComplete([
				{ model: "opus", captures: 1, mainCaptures: 1 },
				{ model: "haiku", captures: 2, mainCaptures: 0 },
			]),
		/requested model run\(s\) produced no matching main capture: haiku/,
	);
});

test("main capture matching requires the probe text and the requested exact id or family", () => {
	const probe = "reply with the single word fingerprint";

	assert.equal(isRequestedMainCapture("opus", "claude-opus-5-20260909", probe, probe), true);
	assert.equal(isRequestedMainCapture("claude-opus-4-8", "claude-opus-4-8-20260909", probe, probe), true);
	assert.equal(isRequestedMainCapture("opus", "claude-opus-5", "auxiliary title request", probe), false);
	assert.equal(isRequestedMainCapture("opus", "claude-sonnet-5", probe, probe), false);
	assert.equal(isRequestedMainCapture("claude-opus-4-8", "claude-opus-4-7", probe, probe), false);
});

test("capture profiles reject user-agent and billing version or entrypoint mismatches", () => {
	const userAgent = "claude-cli/2.1.266 (external, sdk-cli)";
	const billing = "cc_version=2.1.266.abc; cc_entrypoint=sdk-cli;";

	assert.deepEqual(parseCaptureProfile("claude-opus-5", userAgent, billing), {
		version: "2.1.266",
		entrypoint: "sdk-cli",
	});
	assert.throws(
		() =>
			parseCaptureProfile(
				"claude-opus-5",
				userAgent,
				"cc_version=2.1.267.abc; cc_entrypoint=sdk-cli;",
			),
		/user-agent\/billing version mismatch: 2\.1\.266 vs 2\.1\.267/,
	);
	assert.throws(
		() =>
			parseCaptureProfile(
				"claude-opus-5",
				userAgent,
				"cc_version=2.1.266.abc; cc_entrypoint=cli;",
			),
		/user-agent\/billing entrypoint mismatch: sdk-cli vs cli/,
	);
});

test("repeated capture candidates accept identical tuples and reject beta or max_tokens drift", () => {
	const first = candidate("claude-opus-5", ["base-a", "base-b"], ["opus"]);
	const identical = candidate("claude-opus-5", ["base-a", "base-b"], ["claude-opus-5"]);

	assert.doesNotThrow(() => assertConsistentFingerprintCandidate(first, identical));
	assert.throws(
		() =>
			assertConsistentFingerprintCandidate(
				first,
				candidate("claude-opus-5", ["base-a", "base-b", "new-beta"], ["claude-opus-5"]),
			),
		/repeated main captures disagree on anthropic-beta/,
	);
	assert.throws(
		() =>
			assertConsistentFingerprintCandidate(
				first,
				candidate("claude-opus-5", ["base-a", "base-b"], ["claude-opus-5"], { maxTokens: 63_000 }),
			),
		/repeated main captures disagree on max_tokens/,
	);
});

test("dated and clean aliases cannot hide conflicting fingerprint tuples", () => {
	const clean = candidate("claude-opus-5", ["base"], ["claude-opus-5"]);
	const dated = candidate("claude-opus-5-20260909", ["base"], ["opus"]);
	assert.doesNotThrow(() => assertNoCanonicalModelDrift([clean, dated]));
	assert.throws(
		() => assertNoCanonicalModelDrift([clean, { ...dated, maxTokens: 32_000 }]),
		/repeated main captures disagree on max_tokens/,
	);
});

test("non-interactive captures require cch, Agent SDK identity and omitted display", () => {
	const opus = candidate("claude-opus-5", ["base"], ["opus"]);
	const expected = {
		entrypoint: "sdk-cli",
		identity: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
		thinkingDisplay: "omitted",
	};
	assert.doesNotThrow(() => assertNonInteractiveCaptureProfile([opus], expected));
	assert.throws(() => assertNonInteractiveCaptureProfile([{ ...opus, thinkingDisplay: "updates" }], expected), /thinking\.display mismatch/);
	assert.throws(() => selectFingerprintBaseline([{ ...opus, hasCch: false }]), /first-party cch marker is missing/);
});

test("explicit full-id captures select the newest unambiguous Opus and Sonnet generations", () => {
	const candidates = [
		candidate("claude-opus-4-8", ["old"], ["claude-opus-4-8"]),
		candidate("claude-opus-5", ["base", "opus-only"], ["claude-opus-5"]),
		candidate("claude-sonnet-4-6", ["old"], ["claude-sonnet-4-6"]),
		candidate("claude-sonnet-5", ["base"], ["claude-sonnet-5"]),
	];
	const baseline = selectFingerprintBaseline(candidates);

	assert.equal(baseline.opus.wireModel, "claude-opus-5");
	assert.equal(baseline.sonnet.wireModel, "claude-sonnet-5");
	assert.deepEqual(baseline.beta, ["base"]);
});

test("reuse without owners.json falls back to the unique newest wire ids", () => {
	const candidates = [
		candidate("claude-opus-4-8", ["old"], []),
		candidate("claude-opus-5", ["base", "opus-only"], []),
		candidate("claude-sonnet-4-6", ["old"], []),
		candidate("claude-sonnet-5", ["base"], []),
	];
	const baseline = selectFingerprintBaseline(candidates);

	assert.equal(baseline.opus.wireModel, "claude-opus-5");
	assert.equal(baseline.sonnet.wireModel, "claude-sonnet-5");
	assert.deepEqual(baseline.beta, ["base"]);
});

test("fingerprint baseline refuses a missing or ambiguous family", () => {
	const opus = candidate("claude-opus-5", ["base"], ["opus"]);
	assert.throws(() => selectFingerprintBaseline([opus]), /missing Sonnet baseline/i);

	const secondOpus = candidate("claude-opus-5-1", ["base"], ["opus"]);
	const sonnet = candidate("claude-sonnet-5", ["base"], ["sonnet"]);
	assert.throws(() => selectFingerprintBaseline([opus, secondOpus, sonnet]), /ambiguous Opus baseline/i);

	const ownerlessClean = candidate("claude-opus-5", ["base"], []);
	const ownerlessDated = candidate("claude-opus-5-20260909", ["base"], []);
	assert.throws(
		() => selectFingerprintBaseline([ownerlessClean, ownerlessDated, sonnet]),
		/ambiguous Opus baseline/i,
		"wire-id fallback stays fail-closed when the newest generation is tied",
	);
});

test("per-model beta strings and deviations preserve captured order verbatim", () => {
	const candidates = [
		candidate("claude-opus-5", ["base-a", "base-b"], ["opus"]),
		candidate("claude-sonnet-5", ["base-a", "base-b"], ["sonnet"]),
		candidate("claude-fable-5-1", ["base-a", "per-turn", "new-tool", "base-b"], ["claude-fable-5-1"]),
	];

	assert.equal(buildModelBeta(candidates)["claude-fable-5-1"], "base-a,per-turn,new-tool,base-b");
	assert.deepEqual(computeBetaDeviations(candidates, ["base-a", "base-b"]), [
		{ wireModel: "claude-fable-5-1", adds: ["per-turn", "new-tool"], drops: [], reordered: false },
	]);
});

test("per-model max_tokens values are preserved and must be positive integers", () => {
	const candidates = [
		candidate("claude-opus-5", ["base"], ["opus"], { maxTokens: 64_000 }),
		candidate("claude-haiku-4-5", ["base"], ["claude-haiku-4-5"], { maxTokens: 32_000 }),
	];
	assert.deepEqual(buildModelMaxTokens(candidates), {
		"claude-opus-5": 64_000,
		"claude-haiku-4-5": 32_000,
	});

	for (const maxTokens of [undefined, null, 0, -1, 32_000.5, "64000"]) {
		assert.throws(
			() => buildModelMaxTokens([candidate("claude-opus-5", ["base"], ["opus"], { maxTokens })]),
			/max_tokens must be a positive integer/,
			`invalid max_tokens=${String(maxTokens)}`,
		);
	}
});

test("per-model budget-thinking profiles preserve enabled budgets and effort while omitting adaptive models", () => {
	const candidates = [
		candidate("claude-opus-4-5", ["base"], ["claude-opus-4-5"], {
			thinkingType: "enabled",
			budgetTokens: 31_999,
			effort: "high",
		}),
		candidate("claude-sonnet-5", ["base"], ["sonnet"], {
			thinkingType: "adaptive",
			budgetTokens: undefined,
			effort: "xhigh",
		}),
	];

	assert.deepEqual(buildModelBudgetThinking(candidates), {
		"claude-opus-4-5": { budgetTokens: 31_999, effort: "high" },
	});
});

test("capture proxy health proof requires the expected service and nonce", () => {
	const nonce = "fresh-secret";
	const valid = JSON.stringify({ service: "pi-claude-capture-proxy", nonce });
	assert.equal(isCaptureProxyHealthResponse(200, valid, nonce), true);
	assert.equal(isCaptureProxyHealthResponse(200, valid, "different-secret"), false);
	assert.equal(isCaptureProxyHealthResponse(503, valid, nonce), false);
	assert.equal(isCaptureProxyHealthResponse(200, "not json", nonce), false);
});
