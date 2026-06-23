import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWLIST_RE, buildNativeModels, NATIVE_MODELS, parseModelId } from "../src/models.ts";

const OPUS_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const HAIKU_COST = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const OPUS_HI = { compat: { forceAdaptiveThinking: true, supportsTemperature: false }, thinkingLevelMap: { xhigh: "xhigh" } };
const OPUS_MAX = { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "max" } };
const SONNET = { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: undefined };
const HAIKU = { compat: undefined, thinkingLevelMap: undefined };

/**
 * Regression lock for the curated seed. Opus 4.8/4.7/4.6 and Sonnet 4.6 are
 * natively 1M, exposed as a single clean-id entry each; Haiku stays 200K. Update
 * this snapshot deliberately when changing a model.
 */
const EXPECTED_SEED = [
	{ id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1000000, maxTokens: 128000, cost: OPUS_COST, ...OPUS_HI },
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1000000, maxTokens: 128000, cost: OPUS_COST, ...OPUS_HI },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1000000, maxTokens: 128000, cost: OPUS_COST, ...OPUS_MAX },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 1000000, maxTokens: 64000, cost: SONNET_COST, ...SONNET },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200000, maxTokens: 64000, cost: HAIKU_COST, ...HAIKU },
];

test("NATIVE_MODELS reproduces the curated seed exactly (id, name, window, cost, compat, effort)", () => {
	assert.equal(NATIVE_MODELS.length, EXPECTED_SEED.length);
	for (let i = 0; i < EXPECTED_SEED.length; i++) {
		const got = NATIVE_MODELS[i];
		const want = EXPECTED_SEED[i];
		assert.equal(got.id, want.id);
		assert.equal(got.name, want.name);
		assert.equal(got.reasoning, true);
		assert.deepEqual(got.input, ["text", "image"]);
		assert.equal(got.contextWindow, want.contextWindow);
		assert.equal(got.maxTokens, want.maxTokens);
		assert.deepEqual(got.cost, want.cost);
		assert.deepEqual(got.compat, want.compat);
		assert.deepEqual(got.thinkingLevelMap, want.thinkingLevelMap);
	}
});

test("seed exposes natively-1M opus/sonnet (clean ids, no -1m alias) and 200K haiku", () => {
	assert.ok(!NATIVE_MODELS.some((m) => m.id.endsWith("-1m")), "no -1m alias ids");
	for (const m of NATIVE_MODELS) {
		const expected = m.id.startsWith("claude-haiku-") ? 200000 : 1000000;
		assert.equal(m.contextWindow, expected, `${m.id} window`);
	}
});

test("ALLOWLIST_RE accepts current-gen ids and rejects aliases / dated / legacy / 1m-marker ids", () => {
	for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-9"]) {
		assert.ok(ALLOWLIST_RE.test(id), `should accept ${id}`);
	}
	for (const id of ["claude-opus-4.8", "claude-opus-4-1-20250805", "claude-3-opus", "claude-sonnet-4-6-1m"]) {
		assert.ok(!ALLOWLIST_RE.test(id), `should reject ${id}`);
	}
});

test("discovery (A): a new catalog opus id appears as a single native-1M entry", () => {
	const models = buildNativeModels({
		extraIds: ["claude-opus-4-9"],
		catalog: new Map([
			["claude-opus-4-9", { cost: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }, maxTokens: 200000 }],
		]),
	});
	const opus9 = models.filter((m) => m.id === "claude-opus-4-9");
	assert.equal(opus9.length, 1, "exactly one opus entry, no -1m alias");
	const base = opus9[0];
	assert.equal(base.name, "Claude Opus 4.9");
	assert.equal(base.contextWindow, 1000000); // opus is natively 1M
	assert.deepEqual(base.cost, { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }); // from catalog
	assert.equal(base.maxTokens, 200000); // from catalog
	// Conservative effort cap until an explicit overlay says xhigh is supported.
	assert.deepEqual(base.thinkingLevelMap, { xhigh: "max" });
	assert.ok(!models.some((m) => m.id === "claude-opus-4-9-1m"), "no -1m alias");
});

test("overrides (B): a partial override merges over an existing id", () => {
	const models = buildNativeModels({
		overrides: [{ id: "claude-opus-4-8", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	const opus8 = models.find((m) => m.id === "claude-opus-4-8");
	assert.deepEqual(opus8?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(opus8?.name, "Claude Opus 4.8");
	assert.deepEqual(opus8?.thinkingLevelMap, { xhigh: "xhigh" });
});

test("overrides (B): a complete new model is appended; an incomplete one is skipped", () => {
	const models = buildNativeModels({
		overrides: [
			{
				id: "my-custom-model",
				name: "Custom",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
				contextWindow: 200000,
				maxTokens: 8000,
			},
			{ id: "broken-model", name: "Broken" },
		],
	});
	assert.ok(models.some((m) => m.id === "my-custom-model"));
	assert.ok(!models.some((m) => m.id === "broken-model"));
});

test("parseModelId: known families need a minor; new families accept 1- or 2-segment versions", () => {
	// known families: major-minor required (bare legacy ids skipped)
	assert.deepEqual(parseModelId("claude-opus-4-8"), { family: "opus", versionLabel: "4.8" });
	assert.equal(parseModelId("claude-opus-4"), null); // bare legacy → skipped
	// new families: appear on their own (the Q2 goal)
	assert.deepEqual(parseModelId("claude-fable-5"), { family: "fable", versionLabel: "5" });
	assert.deepEqual(parseModelId("claude-mythos-1-0"), { family: "mythos", versionLabel: "1.0" });
	// still rejects dated (3-segment AND 2-segment date) / dotted / 1m-marker / legacy
	for (const id of [
		"claude-opus-4-8-20250805",
		"claude-opus-4-20250514",
		"claude-sonnet-4-20250514",
		"claude-opus-4.8",
		"claude-sonnet-4-6-1m",
		"claude-3-opus",
	]) {
		assert.equal(parseModelId(id), null, `should reject ${id}`);
	}
});

test("discovery (Q2): a brand-new family (fable) auto-appears, fully derived from the catalog", () => {
	const models = buildNativeModels({
		extraIds: ["claude-fable-5"],
		catalog: new Map([
			[
				"claude-fable-5",
				{
					cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
					maxTokens: 32000,
					contextWindow: 200000,
					reasoning: true,
					input: ["text", "image"],
					thinkingLevelMap: { xhigh: "xhigh" },
				},
			],
		]),
	});
	const fable = models.find((m) => m.id === "claude-fable-5");
	assert.ok(fable, "fable should appear without editing the seed");
	assert.equal(fable?.name, "Claude Fable 5");
	assert.equal(fable?.contextWindow, 200000); // unknown family → catalog window, single entry
	assert.equal(fable?.maxTokens, 32000);
	assert.deepEqual(fable?.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
	assert.deepEqual(fable?.thinkingLevelMap, { xhigh: "xhigh" }); // effort derived from catalog
	assert.deepEqual(fable?.compat, { forceAdaptiveThinking: true });
	// no [1m] alias for an unknown family (the 1M wire trick is curated-only)
	assert.ok(!models.some((m) => m.id === "claude-fable-5-1m"));
});

test("the curated seed always survives discovery and allowlist defaults", () => {
	const models = buildNativeModels({ extraIds: ["claude-opus-4-9", "garbage-id"] });
	for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
		assert.ok(models.some((m) => m.id === id), `seed id ${id} must remain`);
	}
	assert.ok(!models.some((m) => m.id === "garbage-id"));
});
