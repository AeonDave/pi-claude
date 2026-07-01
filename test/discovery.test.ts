import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type DiscoveredModel,
	normalizeModelsResponse,
	readModelCache,
	stripDateSuffix,
	writeModelCache,
} from "../src/discovery.ts";
import { buildNativeModels } from "../src/models.ts";

test("stripDateSuffix removes only a trailing 8-digit date", () => {
	assert.equal(stripDateSuffix("claude-sonnet-5-20260630"), "claude-sonnet-5");
	assert.equal(stripDateSuffix("claude-opus-4-1-20250805"), "claude-opus-4-1");
	assert.equal(stripDateSuffix("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet");
	assert.equal(stripDateSuffix("claude-sonnet-5"), "claude-sonnet-5"); // no date → unchanged
	assert.equal(stripDateSuffix("claude-opus-4-8"), "claude-opus-4-8"); // 1-digit minor, not a date
});

// A realistic `/v1/models` page: dated ids, a new family, plus noise to drop.
const V1_MODELS = {
	data: [
		{ id: "claude-sonnet-5-20260630", max_input_tokens: 1000000, max_tokens: 64000, capabilities: { thinking: { supported: true } } },
		{ id: "claude-opus-4-1-20250805", max_input_tokens: 200000, max_tokens: 32000 },
		{ id: "claude-mythos-5-20260615", max_input_tokens: 500000, max_tokens: 32000, capabilities: { thinking: { supported: true } } },
		{ id: "claude-3-5-sonnet-20241022" }, // legacy 3.x → dropped
		{ id: "claude-sonnet-5-latest" }, // non-numeric alias → dropped
		{ id: "claude-opus-4-20250514" }, // strips to claude-opus-4 (legacy bare) → dropped
		{ id: 123 }, // junk
		null,
	],
};

test("normalizeModelsResponse keeps clean claude ids, derives catalog, drops legacy/latest/junk, sets NO cost", () => {
	const models = normalizeModelsResponse(V1_MODELS);
	const ids = models.map((m) => m.id).sort();
	assert.deepEqual(ids, ["claude-mythos-5", "claude-opus-4-1", "claude-sonnet-5"]);

	const s5 = models.find((m) => m.id === "claude-sonnet-5");
	assert.equal(s5?.catalog.contextWindow, 1000000);
	assert.equal(s5?.catalog.maxTokens, 64000);
	assert.equal(s5?.catalog.reasoning, true);
	// /v1/models carries no pricing — cost must be absent so Pi's catalog wins later.
	assert.ok(!("cost" in (s5?.catalog ?? {})), "discovered entries carry no cost");

	const mythos = models.find((m) => m.id === "claude-mythos-5");
	assert.equal(mythos?.catalog.contextWindow, 500000);
});

test("normalizeModelsResponse is defensive against bad shapes", () => {
	assert.deepEqual(normalizeModelsResponse(null), []);
	assert.deepEqual(normalizeModelsResponse({}), []);
	assert.deepEqual(normalizeModelsResponse({ data: "nope" }), []);
	assert.deepEqual(normalizeModelsResponse({ data: [] }), []);
});

test("normalized live models feed buildNativeModels: sonnet-5 + a new family surface (unknown → catalog window)", () => {
	const discovered = normalizeModelsResponse(V1_MODELS);
	const models = buildNativeModels({
		extraIds: discovered.map((m) => m.id),
		catalog: new Map(discovered.map((m) => [m.id, m.catalog])),
	});
	assert.ok(models.some((m) => m.id === "claude-sonnet-5" && m.contextWindow === 1000000));
	const mythos = models.find((m) => m.id === "claude-mythos-5");
	assert.equal(mythos?.name, "Claude Mythos 5");
	assert.equal(mythos?.contextWindow, 500000); // unknown family → real catalog window
});

test("writeModelCache / readModelCache round-trip, and readModelCache filters junk", () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-native-cache-"));
	const path = join(dir, "nested", "models.json"); // nested → exercises mkdir
	try {
		const entries: DiscoveredModel[] = [
			{ id: "claude-sonnet-5", catalog: { contextWindow: 1000000, maxTokens: 64000, reasoning: true } },
			{ id: "claude-mythos-5", catalog: { contextWindow: 500000 } },
		];
		writeModelCache(path, entries);
		assert.deepEqual(readModelCache(path), entries);

		// A cache with legacy/invalid ids and garbage is filtered on read.
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				fetchedAt: "x",
				models: [
					{ id: "claude-sonnet-5", catalog: { contextWindow: 1000000 } },
					{ id: "claude-opus-4" }, // legacy bare → dropped
					{ id: "not-a-claude-id", catalog: {} }, // fails allowlist → dropped
					{ nope: true }, // no id → dropped
				],
			}),
		);
		const read = readModelCache(path);
		assert.deepEqual(read.map((m) => m.id), ["claude-sonnet-5"]);
		assert.deepEqual(read[0].catalog, { contextWindow: 1000000 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readModelCache returns [] for a missing/invalid file", () => {
	assert.deepEqual(readModelCache(join(tmpdir(), "does-not-exist-claude-native.json")), []);
});
