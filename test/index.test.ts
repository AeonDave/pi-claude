import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CLAUDE_AGENT_SDK_IDENTITY,
	CLAUDE_CODE_IDENTITY,
	getAnthropicBetaForModel,
	PROVIDER_ID,
} from "../src/constants.ts";
import { writeModelCache } from "../src/discovery.ts";
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
		assert.equal(haikuBeta?.split(",").length, 11, "Haiku uses the captured non-effort beta set");
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

test("Opus 5.5 is visible at load with a stale cache, while older discovered generations stay visible", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
	const dir = mkdtempSync(join(tmpdir(), "claude-native-cold-list-"));
	const cachePath = join(dir, "models.json");
	process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = cachePath;
	writeModelCache(cachePath, [{
		id: "claude-opus-5",
		catalog: { contextWindow: 1_000_000, maxTokens: 128_000, forceAdaptiveThinking: true },
	}]);
	try {
		const registrations: Array<{ models: Array<Record<string, unknown>> }> = [];
		const { pi } = harness((_id, config) => registrations.push(config as never));
		claudeProMaxNative(pi as never);
		const models = registrations[0]?.models;
		assert.ok(models?.some((model) => model.id === "claude-opus-5"), "a new minor must not hide a bare-major generation");
		const opus55 = models?.find((model) => model.id === "claude-opus-5-5");
		assert.ok(opus55, "cold listing must include the verified bundled snapshot without session_start");
		assert.equal(opus55.contextWindow, 1_000_000);
		assert.equal(opus55.maxTokens, 128_000);
		assert.deepEqual(opus55.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
		assert.deepEqual(opus55.compat, { forceAdaptiveThinking: true, supportsTemperature: false });
		assert.deepEqual(opus55.thinkingLevelMap, { xhigh: "xhigh", max: "max", off: null });
		assert.equal((opus55.headers as Record<string, string>)["anthropic-beta"].split(",").length, 16);
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
		else process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a later catalog price and partial effort map retain Opus 5.5's adaptive-only marker", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
	process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = join(tmpdir(), `claude-native-missing-${randomUUID()}.json`);
	try {
		const registrations: Array<{ models: Array<Record<string, unknown>> }> = [];
		const { pi, handlers } = harness((_id, config) => registrations.push(config as never));
		claudeProMaxNative(pi as never);
		const catalogCost = { input: 3, output: 15, cacheRead: 0.1, cacheWrite: 4 };
		handlers.get("session_start")?.({}, context(() => [{
			id: "claude-opus-5-5",
			provider: "anthropic",
			cost: catalogCost,
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			reasoning: true,
			input: ["text", "image"],
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			compat: {},
		}]));
		const opus55 = registrations.at(-1)?.models.find((model) => model.id === "claude-opus-5-5");
		assert.deepEqual(opus55?.cost, catalogCost);
		assert.deepEqual(opus55?.thinkingLevelMap, { xhigh: "xhigh", max: "max", off: null });
		assert.deepEqual(opus55?.compat, { forceAdaptiveThinking: true, supportsTemperature: false });
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

test("Pi catalog pricing preserves live capabilities and Sonnet 4.5's budget signal", () => {
	const previous = process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
	const dir = mkdtempSync(join(tmpdir(), "claude-native-merge-"));
	const cachePath = join(dir, "models.json");
	process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = cachePath;
	writeModelCache(cachePath, [
		{
			id: "claude-mythos-5",
			catalog: {
				contextWindow: 500000,
				maxTokens: 32000,
				reasoning: true,
				forceAdaptiveThinking: true,
				supportsEffort: true,
				supportsTemperature: false,
				thinkingLevelMap: { xhigh: "xhigh", max: "max", off: null },
			},
		},
		{
			id: "claude-sonnet-4-5",
			catalog: {
				contextWindow: 1000000,
				reasoning: true,
				forceAdaptiveThinking: false,
			},
		},
	]);

	try {
		const registrations: Array<{ models: Array<Record<string, unknown>> }> = [];
		const { pi, handlers } = harness((_id, config) => registrations.push(config as never));
		claudeProMaxNative(pi as never);

		const catalogCost = { input: 7, output: 35, cacheRead: 0.7, cacheWrite: 8.75 };
		const ctx = context(() => [
			{
				id: "claude-mythos-5",
				name: "Claude Mythos 5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text", "image"],
				cost: catalogCost,
				contextWindow: 500000,
				maxTokens: 32000,
				compat: { forceAdaptiveThinking: true },
			},
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1000000,
				maxTokens: 64000,
			},
		]);
		handlers.get("session_start")?.({}, ctx);

		const applied = registrations.at(-1)?.models;
		const mythos = applied?.find((model) => model.id === "claude-mythos-5");
		assert.deepEqual(mythos?.cost, catalogCost, "Pi remains authoritative for pricing");
		assert.deepEqual(mythos?.thinkingLevelMap, { xhigh: "xhigh", max: "max", off: null });
		assert.deepEqual(mythos?.compat, { forceAdaptiveThinking: true, supportsTemperature: false });

		const sonnet45 = applied?.find((model) => model.id === "claude-sonnet-4-5");
		assert.deepEqual(
			sonnet45?.compat,
			{ forceAdaptiveThinking: false },
			"a live budget signal survives Pi's omitted adaptive marker",
		);
		assert.equal(sonnet45?.contextWindow, 200000, "budget Sonnet cannot inherit the beta-gated 1M window");
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_NATIVE_MODELS_CACHE;
		else process.env.PI_CLAUDE_NATIVE_MODELS_CACHE = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("before_provider_request applies the captured Claude Code max_tokens cap", () => {
	const { pi, handlers } = harness(() => {});
	claudeProMaxNative(pi as never);
	const before = handlers.get("before_provider_request");
	assert.ok(before);
	const ctx = {
		model: { provider: PROVIDER_ID, id: "claude-opus-5" },
		modelRegistry: { isUsingOAuth: () => true },
	};
	const result = before(
		{
			payload: {
				max_tokens: 128_000,
				messages: [{ role: "user", content: "hi" }],
				system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
			},
		},
		ctx,
	) as { max_tokens: number };
	assert.equal(result.max_tokens, 64_000);
});

test("request and header hooks emit coherent TUI and print Claude profiles", () => {
	const envNames = [
		"PI_CLAUDE_NATIVE_ANTHROPIC_BETA",
		"PI_CLAUDE_NATIVE_CC_ENTRYPOINT",
		"PI_CLAUDE_NATIVE_USER_AGENT",
	] as const;
	const saved = new Map(envNames.map((name) => [name, process.env[name]]));
	for (const name of envNames) delete process.env[name];

	try {
		const { pi, handlers } = harness(() => {});
		claudeProMaxNative(pi as never);
		const beforeRequest = handlers.get("before_provider_request");
		const beforeHeaders = handlers.get("before_provider_headers");
		assert.ok(beforeRequest);
		assert.ok(beforeHeaders);

		const applyProfile = (mode: "tui" | "print", sourceIdentity: string) => {
			const ctx = {
				mode,
				model: { provider: PROVIDER_ID, id: "claude-opus-5" },
				modelRegistry: { isUsingOAuth: () => true },
			};
			const transformed = beforeRequest(
				{
					payload: {
						max_tokens: 8_192,
						messages: [{ role: "user", content: "hi" }],
						system: [{ type: "text", text: sourceIdentity }, { type: "text", text: "pi system prompt" }],
						thinking: { type: "adaptive", display: "summarized" },
					},
				},
				ctx,
			) as {
				system: Array<{ type: string; text: string }>;
				thinking: { type: string; display: string };
			};
			const headers: Record<string, string> = {};
			beforeHeaders({ type: "before_provider_headers", headers }, ctx);
			return { transformed, headers };
		};

		const tui = applyProfile("tui", CLAUDE_AGENT_SDK_IDENTITY);
		assert.match(tui.transformed.system[0]?.text ?? "", /cc_entrypoint=cli;/);
		assert.equal(tui.transformed.system[1]?.text, CLAUDE_CODE_IDENTITY);
		assert.equal(tui.transformed.thinking.display, "updates");
		assert.match(tui.headers["user-agent"] ?? "", /^claude-cli\/[0-9]+\.[0-9]+\.[0-9]+ \(external, cli\)$/);
		assert.equal(tui.headers["anthropic-beta"], getAnthropicBetaForModel("claude-opus-5", "tui"));
		assert.ok(tui.headers["anthropic-beta"].includes("thinking-display-updates-2026-08-18"));
		assert.equal(tui.headers["anthropic-beta"].includes("fallback-credit-2026-06-01"), false);
		assert.match(tui.transformed.system[0]?.text ?? "", / cc_turn_origin=human;$/);
		assert.equal(tui.headers["x-claude-code-request-class"], "main");

		const print = applyProfile("print", CLAUDE_CODE_IDENTITY);
		assert.match(print.transformed.system[0]?.text ?? "", /cc_entrypoint=sdk-cli;/);
		assert.equal(print.transformed.system[1]?.text, CLAUDE_AGENT_SDK_IDENTITY);
		assert.equal(print.transformed.thinking.display, "omitted");
		assert.match(print.headers["user-agent"] ?? "", /^claude-cli\/[0-9]+\.[0-9]+\.[0-9]+ \(external, sdk-cli\)$/);
		assert.equal(print.headers["anthropic-beta"], getAnthropicBetaForModel("claude-opus-5", "print"));
		assert.equal(print.headers["anthropic-beta"].includes("thinking-display-updates-2026-08-18"), false);
		assert.equal(print.headers["anthropic-beta"].includes("fallback-credit-2026-06-01"), false);
		assert.match(print.transformed.system[0]?.text ?? "", / cc_turn_origin=sdk;$/);
		assert.equal(print.headers["x-claude-code-request-class"], "main");
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("x-client-request-id is set per request, in place, and only for this provider", () => {
	const { pi, handlers } = harness(() => {});
	claudeProMaxNative(pi as never);
	const hook = handlers.get("before_provider_headers");
	assert.ok(hook, "the hook must be registered (Pi >= 0.80.5 fires it)");

	const nativeCtx = {
		model: { provider: PROVIDER_ID, id: "claude-opus-5" },
		modelRegistry: { getAll: () => [], isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
		ui: { setStatus() {} },
	};

	// Pi ignores the handler's return value and forwards the SAME object, so the
	// header only reaches the wire if it is mutated in place.
	const headers: Record<string, string> = {};
	hook({ type: "before_provider_headers", headers }, nativeCtx);
	const first = headers["x-client-request-id"];
	assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	assert.equal(headers["x-claude-code-request-class"], "main");

	// Genuine Claude Code sends a FRESH id on every request.
	const second: Record<string, string> = {};
	hook({ type: "before_provider_headers", headers: second }, nativeCtx);
	assert.notEqual(second["x-client-request-id"], first, "each request gets its own id");

	// Never touch another provider's request.
	const foreign: Record<string, string> = {};
	hook(
		{ type: "before_provider_headers", headers: foreign },
		{
			model: { provider: "anthropic", id: "claude-opus-5" },
			modelRegistry: { getAll: () => [], isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
			ui: { setStatus() {} },
		},
	);
	assert.deepEqual(foreign, {}, "scoped strictly to this provider");
});

test("the full before_provider_request chain produces a valid budget-thinking request", () => {
	// The riskiest new code (identity → display → max_tokens cap → budget profile)
	// was only ever asserted one transform at a time. This exercises the real hook
	// end-to-end and checks the invariant Anthropic enforces: budget_tokens < max_tokens.
	const { pi, handlers } = harness(() => {});
	claudeProMaxNative(pi as never);
	const hook = handlers.get("before_provider_request");
	assert.ok(hook, "before_provider_request must be registered");

	const ctx = {
		mode: "print",
		model: { provider: PROVIDER_ID, id: "claude-sonnet-4-5" },
		modelRegistry: { getAll: () => [], isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
		ui: { setStatus() {} },
	};

	// Pi's stock `high` budget (16384) against its catalog ceiling.
	const payload = {
		model: "claude-sonnet-4-5",
		max_tokens: 64_000,
		thinking: { type: "enabled", budget_tokens: 16_384 },
		system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	};

	const out = hook({ type: "before_provider_request", payload }, ctx) as {
		max_tokens: number;
		thinking: { type: string; budget_tokens: number; display: string };
		system: Array<{ text: string }>;
	};

	assert.ok(out, "the chain must rewrite this payload");
	assert.ok(
		out.thinking.budget_tokens < out.max_tokens,
		`budget_tokens (${out.thinking.budget_tokens}) must stay below max_tokens (${out.max_tokens}) or Anthropic 400s`,
	);
	assert.equal(out.system[0].text.startsWith("x-anthropic-billing-header:"), true, "billing header is system[0]");

	// A caller-chosen budget larger than the captured cap must not be clamped into
	// an invalid pair (the regression this review found).
	const big = { ...payload, thinking: { type: "enabled", budget_tokens: 40_000 } };
	const bigOut = hook({ type: "before_provider_request", payload: big }, ctx) as {
		max_tokens: number;
		thinking: { budget_tokens: number };
	};
	assert.ok(
		bigOut.thinking.budget_tokens < bigOut.max_tokens,
		`budget_tokens (${bigOut.thinking.budget_tokens}) must stay below max_tokens (${bigOut.max_tokens})`,
	);
});
