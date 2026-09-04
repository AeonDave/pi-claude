import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import claudeProMaxNative from "../src/index.ts";

// Isolation: never read the developer's REAL ~/.pi/claude-native-fingerprint.json.
// A locally-applied capture (a newer version, or a per-model `modelBeta` set)
// silently changes the flag counts asserted below, so the suite would pass or fail
// depending on whose machine it runs on. Point at a path that cannot exist.
process.env.PI_CLAUDE_NATIVE_FINGERPRINT = join(tmpdir(), `claude-native-absent-fingerprint-${randomUUID()}.json`);
// Live discovery is on by default; tests must never hit the network.
process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY = "0";

const FABLE_COST = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

function fableModel(cost = FABLE_COST) {
	return {
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinkingLevelMap: { off: null, xhigh: "xhigh" },
		input: ["text", "image"],
		cost,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: { forceAdaptiveThinking: true },
	};
}

function harness(registerProvider: (id: string, config: unknown) => void) {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerProvider,
		registerCommand() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	return { pi, handlers };
}

function context(getAll: () => unknown[]) {
	return {
		model: undefined,
		modelRegistry: {
			getAll,
			isUsingOAuth: () => false,
			getApiKeyForProvider: async () => undefined,
		},
		ui: { setStatus() {} },
	};
}

test("session refresh re-registers when catalog fields change without an id/window change", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
	process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = join(tmpdir(), `claude-native-missing-${randomUUID()}.json`);
	try {
		const registrations: unknown[] = [];
		const { pi, handlers } = harness((_id, config) => registrations.push(config));
		claudeProMaxNative(pi as never);
		const initial = registrations[0] as { models: Array<{ id: string; headers?: Record<string, string> }> };
		const haikuBeta = initial.models.find((model) => model.id === "claude-haiku-4-5")?.headers?.["anthropic-beta"];
		assert.equal(haikuBeta?.split(",").length, 10, "Haiku uses the captured non-effort beta set");
		assert.ok(!haikuBeta?.includes("afk-mode-2026-01-31"));

		let catalog = [fableModel()];
		const ctx = context(() => catalog);
		const start = handlers.get("session_start");
		assert.ok(start);
		start({}, ctx);
		assert.equal(registrations.length, 2, "initial seed, then catalog-backed Fable");

		catalog = [fableModel({ ...FABLE_COST, input: 11 })];
		start({}, ctx);
		assert.equal(registrations.length, 3, "changed catalog data must not be hidden by the signature cache");
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
		else process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = previous;
	}
});

test("a failed provider registration is retried with the same model set", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
	process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = join(tmpdir(), `claude-native-missing-${randomUUID()}.json`);
	try {
		let attempts = 0;
		let successful = 0;
		const { pi, handlers } = harness(() => {
			attempts++;
			if (attempts === 2) throw new Error("transient registry failure");
			successful++;
		});
		claudeProMaxNative(pi as never);

		const ctx = context(() => [fableModel()]);
		const start = handlers.get("session_start");
		assert.ok(start);
		start({}, ctx);
		start({}, ctx);

		assert.equal(attempts, 3, "the second session refresh retries the failed registration");
		assert.equal(successful, 2, "seed and recovered catalog registration both succeed");
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
		else process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = previous;
	}
});
