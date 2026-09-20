import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertConsistentFingerprintCandidate,
	assertNoCanonicalModelDrift,
	assertNonInteractiveCaptureProfile,
	assertRequestedCapturesComplete,
	buildTuiFingerprint,
	buildModelBeta,
	buildModelBudgetThinking,
	buildModelMaxTokens,
	computeBetaDeviations,
	DEFAULT_CAPTURE_MODELS,
	DEFAULT_TUI_CAPTURE_MODELS,
	isCaptureProxyHealthResponse,
	isRequestedMainCapture,
	isRequestedTuiCapture,
	lastUserMessageText,
	parseCaptureProfile,
	selectTuiCaptureCandidates,
	selectFingerprintBaseline,
	type FingerprintCandidate,
} from "../scripts/fingerprint-baseline.ts";

const FIXTURE_VERSION = "9.8.7";
const OTHER_FIXTURE_VERSION = "9.8.8";
const userAgentFor = (entrypoint: string) => `claude-cli/${FIXTURE_VERSION} (external, ${entrypoint})`;

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
		version: FIXTURE_VERSION,
		entrypoint: "sdk-cli",
		userAgent: userAgentFor("sdk-cli"),
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

test("lastUserMessageText selects the current interactive prompt after history", () => {
	assert.equal(lastUserMessageText({
		messages: [
			{ role: "user", content: "old prompt" },
			{ role: "assistant", content: "old response" },
			{ role: "user", content: [{ type: "text", text: "current prompt" }, { type: "tool_result", content: "ignored" }] },
		]},), "current prompt");
	assert.equal(lastUserMessageText({ messages: [{ role: "user", content: "current string" }] }), "current string");
	assert.equal(lastUserMessageText({ messages: [{ role: "user", content: [{ type: "tool_result" }] }] }), undefined);
});

test("TUI probe selection forwards profile and tool drift to strict validation", () => {
	const prompt = "probe";
	assert.equal(isRequestedTuiCapture({ model: "claude-fable-5-2", messages: [{ role: "user", content: prompt }] }, prompt), true);
	assert.equal(isRequestedTuiCapture({
		model: "claude-fable-5-2",
		messages: [{ role: "user", content: prompt }],
		tools: [],
		requestClass: "auxiliary",
	}, prompt), true, "selection must not hide a malformed matching turn");
	assert.equal(isRequestedTuiCapture({ model: "claude-fable-5-2", messages: [{ role: "user", content: "other" }] }, prompt), false);
	assert.equal(isRequestedTuiCapture({ messages: [{ role: "user", content: prompt }] }, prompt), false);
});

test("capture profiles reject user-agent and billing version or entrypoint mismatches", () => {
	const userAgent = userAgentFor("sdk-cli");
	const billing = `cc_version=${FIXTURE_VERSION}.abc; cc_entrypoint=sdk-cli;`;

	assert.deepEqual(parseCaptureProfile("claude-opus-5", userAgent, billing), {
		version: FIXTURE_VERSION,
		entrypoint: "sdk-cli",
	});
	assert.throws(
		() =>
			parseCaptureProfile(
				"claude-opus-5",
				userAgent,
				`cc_version=${OTHER_FIXTURE_VERSION}.abc; cc_entrypoint=sdk-cli;`,
			),
		new RegExp(`user-agent/billing version mismatch: ${FIXTURE_VERSION.replaceAll(".", "\\.")} vs ${OTHER_FIXTURE_VERSION.replaceAll(".", "\\.")}`),
	);
	assert.throws(
		() =>
			parseCaptureProfile(
				"claude-opus-5",
				userAgent,
				`cc_version=${FIXTURE_VERSION}.abc; cc_entrypoint=cli;`,
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

test("TUI captures require the bundled exact model set and emit overlay fields", () => {
	const candidates = DEFAULT_TUI_CAPTURE_MODELS.map((model) => candidate(model, ["base", "thinking-display-updates-2026-08-18"], [model], {
		version: FIXTURE_VERSION,
		entrypoint: "cli",
		userAgent: userAgentFor("cli"),
		identity: "You are Claude Code, Anthropic's official CLI for Claude.",
		thinkingDisplay: "updates",
		thinkingType: "adaptive",
		hasCch: true,
		toolsCount: 1,
		requestClass: "main",
		turnOrigin: "human",
	}));
	const selected = selectTuiCaptureCandidates(candidates);
	const fingerprint = buildTuiFingerprint(selected, "2026-09-20T00:00:00.000Z");

	assert.equal(selected.length, DEFAULT_TUI_CAPTURE_MODELS.length);
	assert.equal(fingerprint.version, FIXTURE_VERSION);
	assert.equal(fingerprint.entrypoint, "cli");
	assert.equal(fingerprint.modelBeta["claude-opus-5"], "base,thinking-display-updates-2026-08-18");
	assert.equal(fingerprint.modelMaxTokens["claude-opus-5"], 64_000);
	assert.deepEqual(fingerprint.modelThinking["claude-opus-5"], {
		type: "adaptive",
		display: "updates",
		budgetTokens: null,
		effort: "xhigh",
	});
});

test("TUI capture validation accepts and distills additional clean model ids", () => {
	const base = DEFAULT_TUI_CAPTURE_MODELS.map((model) => candidate(model, ["base", "thinking-display-updates-2026-08-18"], [model], {
		version: FIXTURE_VERSION,
		entrypoint: "cli",
		userAgent: userAgentFor("cli"),
		identity: "You are Claude Code, Anthropic's official CLI for Claude.",
		thinkingDisplay: "updates",
		thinkingType: "adaptive",
		hasCch: true,
		toolsCount: 1,
		requestClass: "main",
		turnOrigin: "human",
	}));
	const future = candidate("claude-fable-5-2", ["base", "future-exact-flag"], ["claude-fable-5-2"], {
		version: FIXTURE_VERSION,
		entrypoint: "cli",
		userAgent: userAgentFor("cli"),
		identity: "You are Claude Code, Anthropic's official CLI for Claude.",
		thinkingDisplay: "updates",
		thinkingType: "adaptive",
		hasCch: true,
		toolsCount: 1,
		requestClass: "main",
		turnOrigin: "human",
	});
	const selected = selectTuiCaptureCandidates([...base, future]);
	const fingerprint = buildTuiFingerprint(selected, "2030-01-02T00:00:00.000Z");

	assert.equal(selected.length, DEFAULT_TUI_CAPTURE_MODELS.length + 1);
	assert.equal(selected.at(-1)?.wireModel, "claude-fable-5-2");
	assert.equal(fingerprint.modelBeta["claude-fable-5-2"], "base,future-exact-flag");
	assert.equal(fingerprint.modelMaxTokens["claude-fable-5-2"], 64_000);
	assert.throws(
		() => selectTuiCaptureCandidates([...base, { ...future, wireModel: "claude-fable-latest" }]),
		/unexpected TUI capture model/i,
	);
});

test("TUI capture validation rejects a missing id, profile mismatch, duplicate beta, or long-context beta", () => {
	const base = DEFAULT_TUI_CAPTURE_MODELS.map((model) => candidate(model, ["base", "thinking-display-updates-2026-08-18"], [model], {
		version: FIXTURE_VERSION,
		entrypoint: "cli",
		userAgent: userAgentFor("cli"),
		identity: "You are Claude Code, Anthropic's official CLI for Claude.",
		thinkingDisplay: "updates",
		hasCch: true,
		toolsCount: 1,
		requestClass: "main",
		turnOrigin: "human",
	}));

	assert.throws(() => selectTuiCaptureCandidates(base.slice(1)), /missing TUI capture/i);
	assert.throws(() => selectTuiCaptureCandidates([{ ...base[0], entrypoint: "sdk-cli" }, ...base.slice(1)]), /expected cli/i);
	assert.throws(
		() => selectTuiCaptureCandidates([...base, { ...base[0], entrypoint: "sdk-cli", userAgent: userAgentFor("sdk-cli") }]),
		/expected cli/i,
		"a mixed-mode duplicate cannot be filtered as auxiliary traffic",
	);
	assert.throws(() => selectTuiCaptureCandidates([{ ...base[0], requestClass: "title" }, ...base.slice(1)]), /request-class=main/i);
	assert.throws(() => selectTuiCaptureCandidates([{ ...base[0], turnOrigin: "system" }, ...base.slice(1)]), /turn_origin=human/i);
	assert.throws(() => selectTuiCaptureCandidates([{ ...base[0], beta: ["base", "base"] }, ...base.slice(1)]), /duplicate flags/i);
	assert.throws(() => selectTuiCaptureCandidates([{ ...base[0], beta: ["base", "context-1m-2025-08-07"] }, ...base.slice(1)]), /context-1m/i);
});

test("TUI capture validation rejects inconsistent repeated observations for one id", () => {
	const candidates = DEFAULT_TUI_CAPTURE_MODELS.map((model) => candidate(model, ["base", "thinking-display-updates-2026-08-18"], [model], {
		version: FIXTURE_VERSION,
		entrypoint: "cli",
		userAgent: userAgentFor("cli"),
		identity: "You are Claude Code, Anthropic's official CLI for Claude.",
		thinkingDisplay: "updates",
		hasCch: true,
		toolsCount: 1,
		requestClass: "main",
		turnOrigin: "human",
	}));
	assert.throws(
		() => selectTuiCaptureCandidates([...candidates, { ...candidates[0], maxTokens: 32_000 }]),
		/repeated main captures disagree on max_tokens/,
	);
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
