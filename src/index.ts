/**
 * Claude Pro/Max Native — a Pi provider that talks to Anthropic exactly like the
 * genuine Claude Code CLI, so a Claude Pro/Max subscription works inside Pi
 * without tripping Anthropic's third-party-client checks.
 *
 * Design (see README): the provider reuses Pi's battle-tested
 * `api: "anthropic-messages"` path, which already sends the Claude Code identity,
 * the OAuth/Claude-Code beta headers, Bearer auth, `x-app: cli`, and Claude-Code
 * tool-name canonicalization (with round-trip on the response). On top of that
 * this extension adds the only two things Pi's path omits:
 *
 *   1. a current, suffixed `user-agent` (`claude-cli/<v> (external, cli)`), via
 *      provider `headers`; and
 *   2. Claude Code's `x-anthropic-billing-header` system block, via
 *      `before_provider_request`.
 *
 * The provider's own OAuth makes it appear under `/login` as "Claude Pro/Max
 * Native" and stores an `sk-ant-oat...` token, which is what flips Pi's built-in
 * Anthropic path into full Claude-Code-mimicry mode.
 *
 * Model list: registered at load from the curated seed + a persisted discovery
 * cache, then refreshed on `session_start` from Pi's built-in `anthropic` catalog
 * (so a newly-shipped Claude appears on its own) plus any
 * `PI_CLAUDE_NATIVE_MODELS` overrides. With `PI_CLAUDE_NATIVE_LIVE_DISCOVERY` set,
 * it also queries Anthropic's live `/v1/models` once per process and persists the
 * result as the cache. `registerProvider` may be called again at runtime and
 * takes effect immediately, with no `/reload`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getAnthropicBeta,
	getBaseUrl,
	getClaudeCodeEntrypoint,
	getClaudeCodeVersion,
	getClaudeUserId,
	getModelAllowlist,
	getModelCachePath,
	getModelOverrides,
	getSanitizeRules,
	getUserAgent,
	isLiveDiscoveryEnabled,
	PROVIDER_ID,
	PROVIDER_NAME,
} from "./constants.ts";
import { logNativeRequest } from "./debug.ts";
import { type DiscoveredModel, fetchLiveModels, readModelCache, writeModelCache } from "./discovery.ts";
import { ALLOWLIST_RE, buildNativeModels, type CatalogEntry, type NativeModel } from "./models.ts";
import { getApiKey, login, refreshToken } from "./oauth.ts";
import { applyBillingHeader, applyMetadata, sanitizeSystemPrompt } from "./payload.ts";

const STATUS_KEY = "claude-native";

/** True only for this provider's requests when authenticated via OAuth. */
function isNativeOAuth(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return !!model && model.provider === PROVIDER_ID && ctx.modelRegistry.isUsingOAuth(model);
}

/** Footer status; best-effort (headless hosts may not have a theme/UI). */
function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// Status badge is cosmetic — never let it break the session.
	}
}

export default function claudeProMaxNative(pi: ExtensionAPI) {
	// These override Pi's defaults (merged last in Pi's Anthropic client, so they
	// win): the genuine external-CLI user-agent, and the exact Claude Code 2.1.186
	// `anthropic-beta` set. `x-app` restates Pi's own default for robustness.
	const headers: Record<string, string> = {
		"user-agent": getUserAgent(),
		"x-app": "cli",
		"anthropic-beta": getAnthropicBeta(),
	};

	const oauth = { name: PROVIDER_NAME, login, refreshToken, getApiKey };

	// Re-registering with the same model set is a no-op we can skip; track the last
	// applied signature so session_start refreshes don't churn the registry.
	let lastSignature = "";

	function registerNative(models: NativeModel[]): void {
		const signature = models.map((m) => `${m.id}@${m.contextWindow}`).join(",");
		if (signature === lastSignature) return;
		lastSignature = signature;
		// No per-model long-context header: the curated families are natively 1M,
		// so they expose their full window under their clean id without the
		// `context-1m-2025-08-07` beta — which a plan lacking long-context rejects
		// with a 400/429. Force it back via PI_CLAUDE_NATIVE_ANTHROPIC_BETA only if
		// your subscription needs it to unlock >200K.
		try {
			pi.registerProvider(PROVIDER_ID, {
				name: PROVIDER_NAME,
				baseUrl: getBaseUrl(),
				api: "anthropic-messages",
				headers,
				models,
				oauth,
			});
		} catch (err) {
			// Keep whatever model set was last applied; a transient registry error
			// must not take the provider down.
			try {
				process.stderr.write(`[claude-native] registerProvider failed: ${(err as Error).message}\n`);
			} catch {
				// best-effort
			}
		}
	}

	// The most recent successful live `/v1/models` fetch (in-memory), and a guard
	// so we fetch at most once per process and never concurrently.
	let liveModels: DiscoveredModel[] = [];
	let liveInFlight = false;
	let liveFetched = false;

	/**
	 * Build the merged model list from all discovery sources, lowest precedence
	 * first so a later source overrides earlier ones per-field:
	 *   1. the persisted cache  — a previous live fetch (fresh offline fallback);
	 *   2. this run's live fetch — overrides the cache;
	 *   3. Pi's built-in `anthropic` catalog — authoritative (it alone carries real
	 *      `cost`, since `/v1/models` has none), so it wins where it knows the id.
	 * The curated seed + user overrides are layered on by `buildNativeModels`.
	 * `ctx` is omitted at load time (before any session), when only 1+2 apply.
	 */
	function buildMergedModels(ctx?: ExtensionContext): NativeModel[] {
		const allowlist = getModelAllowlist();
		const allow = allowlist ?? ALLOWLIST_RE;
		const catalog = new Map<string, CatalogEntry>();
		const extraIds: string[] = [];
		const add = (id: string, entry: CatalogEntry): void => {
			if (!allow.test(id)) return;
			catalog.set(id, { ...catalog.get(id), ...entry });
			if (!extraIds.includes(id)) extraIds.push(id);
		};
		for (const m of readModelCache(getModelCachePath())) add(m.id, m.catalog);
		for (const m of liveModels) add(m.id, m.catalog);
		if (ctx) {
			for (const model of ctx.modelRegistry.getAll()) {
				if (model.provider !== "anthropic") continue;
				// Carry everything Pi knows so an unknown family (e.g. fable) is fully derived.
				add(model.id, {
					cost: model.cost,
					maxTokens: model.maxTokens,
					contextWindow: model.contextWindow,
					reasoning: model.reasoning,
					input: model.input,
					thinkingLevelMap: model.thinkingLevelMap,
				});
			}
		}
		return buildNativeModels({ extraIds, catalog, overrides: getModelOverrides(), allowlist });
	}

	/** Re-register from all sources; best-effort (the seed registered at load stands). */
	function refreshModels(ctx: ExtensionContext): void {
		try {
			registerNative(buildMergedModels(ctx));
		} catch {
			// Discovery is best-effort; the seed registered at load still stands.
		}
	}

	/**
	 * Opt-in: query Anthropic's `/v1/models` with the subscription OAuth token,
	 * persist it as the local fallback, and re-register. At most once per process,
	 * never concurrent; any failure degrades silently to cache + seed.
	 */
	async function runLiveDiscovery(ctx: ExtensionContext): Promise<void> {
		if (liveInFlight || liveFetched || !isLiveDiscoveryEnabled()) return;
		liveInFlight = true;
		try {
			const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
			if (!token) return;
			const fetched = await fetchLiveModels({ token, endpoint: `${getBaseUrl()}/v1/models`, userAgent: getUserAgent() });
			if (fetched.length === 0) return;
			liveModels = fetched;
			liveFetched = true;
			writeModelCache(getModelCachePath(), fetched);
			refreshModels(ctx); // re-register with the fresh set (takes effect immediately)
		} catch {
			// best-effort; the cache/seed still stand
		} finally {
			liveInFlight = false;
		}
	}

	// Initial registration: curated seed + user overrides + persisted cache. Works
	// offline and at load time, before any session context exists.
	registerNative(buildMergedModels());

	// Add the missing x-anthropic-billing-header as system[0], scoped strictly to
	// this provider's OAuth requests so nothing else is ever touched.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isNativeOAuth(ctx)) return;
		const version = getClaudeCodeVersion();
		const entrypoint = getClaudeCodeEntrypoint();
		// Strip third-party-harness fingerprints from the system prompt (Anthropic
		// 400s these as a disguised usage error), then add the genuine Claude Code
		// metadata.user_id, then the billing header. Order is independent: the cch
		// hashes the first user message, not the system blocks.
		let next = sanitizeSystemPrompt(event.payload, getSanitizeRules());
		next = applyMetadata(next, getClaudeUserId());
		next = applyBillingHeader(next, version, entrypoint);
		logNativeRequest(next, { model: ctx.model?.id, userAgent: getUserAgent(), version, entrypoint });
		return next === event.payload ? undefined : next;
	});

	pi.on("session_start", (_event, ctx) => {
		refreshModels(ctx);
		void runLiveDiscovery(ctx); // self-gates on PI_CLAUDE_NATIVE_LIVE_DISCOVERY
		setStatus(ctx, isNativeOAuth(ctx) ? `✓ ${PROVIDER_NAME}` : undefined);
	});

	pi.on("model_select", (_event, ctx) => {
		setStatus(ctx, isNativeOAuth(ctx) ? `✓ ${PROVIDER_NAME}` : undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setStatus(ctx, undefined);
	});

	pi.registerCommand("claude-native", {
		description: `Diagnostics for the ${PROVIDER_NAME} provider`,
		handler: async (_args, ctx) => {
			const active = isNativeOAuth(ctx);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
			const nativeModels = ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER_ID);
			const nativeIds = new Set(nativeModels.map((m) => m.id));
			// Stale-model footgun: the native provider intentionally reuses the
			// builtin `anthropic` ids (e.g. claude-opus-4-8), so a selection that
			// resolves by id alone can silently bind to `anthropic/<id>` (which needs
			// an API key) instead of this provider. Detect and call it out.
			const collides =
				!!ctx.model && ctx.model.provider === "anthropic" && nativeIds.has(ctx.model.id);
			const lines = [
				`${PROVIDER_NAME} (${PROVIDER_ID})`,
				`  active here:    ${active ? "yes" : "no"}`,
				`  selected model: ${model}`,
				`  models:         ${nativeModels.length} (${nativeModels.map((m) => m.id).join(", ") || "none"})`,
				`  cc_version:     ${getClaudeCodeVersion()}`,
				`  cc_entrypoint:  ${getClaudeCodeEntrypoint()}`,
				`  user-agent:     ${getUserAgent()}`,
				`  live discovery: ${isLiveDiscoveryEnabled() ? "on" : "off"} (cache: ${readModelCache(getModelCachePath()).length} models)`,
			];
			if (collides) {
				lines.push(
					"",
					`⚠ STALE MODEL: selected anthropic/${ctx.model?.id}, but ${PROVIDER_ID}/${ctx.model?.id} exists.`,
					`  Same id under both providers — you're on the builtin (API-key) one, not the subscription.`,
					`  Fix: /model → pick the "${PROVIDER_ID}/" variant (re-select it even if it looks chosen).`,
				);
			} else if (!active) {
				lines.push("", `Run /login → "${PROVIDER_NAME}", then pick a model with /model.`);
			}
			ctx.ui.notify(lines.join("\n"), collides ? "warning" : "info");
		},
	});
}
