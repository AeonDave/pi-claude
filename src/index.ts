/**
 * Claude Pro/Max Native — a Pi provider that talks to Anthropic exactly like the
 * genuine Claude Code CLI, so a Claude Pro/Max subscription works inside Pi
 * without tripping Anthropic's third-party-client checks.
 *
 * Design (see README): the provider reuses Pi's battle-tested
 * `api: "anthropic-messages"` path, which already sends the initial Claude Code
 * identity, OAuth/Bearer headers, `x-app: cli`, and Claude-Code tool-name
 * canonicalization (with response round-trip). On top of that this extension
 * supplies mode-aware identity/user-agent/beta/thinking signals plus the body
 * fields Pi omits: billing header, metadata user id, the captured request cap,
 * and system-prompt classifier sanitization.
 *
 * The provider's own OAuth makes it appear under `/login` as "Claude Pro/Max
 * Native" and stores an `sk-ant-oat...` token, which is what flips Pi's built-in
 * Anthropic path into full Claude-Code-mimicry mode.
 *
 * Model list: registered at load from the curated seed, a verified low-priority
 * release snapshot, and a persisted discovery cache, then refreshed on
 * `session_start` from Pi's built-in `anthropic` catalog plus any
 * `PI_CLAUDE_NATIVE_MODELS` overrides. Unless explicitly disabled with
 * `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0`, it also queries Anthropic's live
 * `/v1/models` once per process and persists the result as the cache. Listing
 * models before a session cannot perform that authenticated refresh.
 * `registerProvider` may be called again at runtime and takes effect immediately,
 * with no `/reload`.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getAnthropicBeta,
	getAnthropicBetaForModel,
	getBaseUrl,
	getClaudeCodeEntrypoint,
	getClaudeCodeIdentity,
	getClaudeCodeBudgetThinkingProfileForModel,
	getClaudeCodeMaxTokensForModel,
	getClaudeCodeThinkingDisplay,
	getClaudeCodeVersion,
	getClaudeCodeVersionInfo,
	getClaudeUserId,
	getModelAllowlist,
	getModelCachePath,
	getModelCacheReadPaths,
	getModelOverrides,
	getSanitizeRules,
	getSessionId,
	getUserAgent,
	isLiveDiscoveryEnabled,
	migrateLegacyState,
	PROVIDER_ID,
	PROVIDER_NAME,
} from "./constants.ts";
import { logNativeRequest } from "./debug.ts";
import { BUNDLED_MODEL_SNAPSHOT, type DiscoveredModel, fetchLiveModels, readModelCache, writeModelCache } from "./discovery.ts";
import { ALLOWLIST_RE, buildNativeModels, type CatalogEntry, type NativeModel } from "./models.ts";
import { getApiKey, login, refreshToken } from "./oauth.ts";
import {
	applyBillingHeader,
	applyClaudeCodeIdentity,
	applyClaudeCodeBudgetThinkingProfile,
	applyClaudeCodeMaxTokens,
	applyClaudeCodeThinkingDisplay,
	applyContextManagement,
	applyDiagnostics,
	applyMetadata,
	sanitizeSystemPrompt,
} from "./payload.ts";

const STATUS_KEY = "claude-native";

/**
 * The persisted discovery cache, from the first path that yields anything —
 * current location first, then the pre-1.5.0 loose file so an existing install
 * keeps its offline fallback across the move into `<agent dir>/claude-native/`.
 */
function readCachedModels(): DiscoveredModel[] {
	for (const path of getModelCacheReadPaths()) {
		const models = readModelCache(path);
		if (models.length > 0) return models;
	}
	return [];
}

/** Where `/claude-native` says the wire `cc_version` came from. */
const VERSION_SOURCE_LABEL: Record<string, string> = {
	env: "PI_CLAUDE_NATIVE_CC_VERSION",
	fingerprint: "captured fingerprint",
	installed: "your installed claude",
	default: "built-in fallback",
};

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
	// Move any pre-1.5.0 loose `~/.pi/claude-native-*.json` onto Pi's per-extension
	// state convention BEFORE anything reads them (the fingerprint is memoized on
	// first read). Best-effort and idempotent.
	migrateLegacyState();

	// These provide a safe non-interactive fallback at registration time. The
	// per-request headers hook below overwrites user-agent and beta from `ctx.mode`
	// so TUI (`cli`) and print/json/rpc (`sdk-cli`) match their genuine profiles.
	// `x-app` restates Pi's own default for robustness.
	// `x-claude-code-session-id` (added in 2.1.241) matches metadata session_id.
	const headers: Record<string, string> = {
		"user-agent": getUserAgent(),
		"x-app": "cli",
		"x-claude-code-request-class": "main",
		"anthropic-beta": getAnthropicBeta(),
		"x-claude-code-session-id": getSessionId(),
	};

	const oauth = { name: PROVIDER_NAME, login, refreshToken, getApiKey };

	// Re-registering with the same model set is a no-op we can skip; track the last
	// applied signature so session_start refreshes don't churn the registry.
	let lastSignature = "";

	function registerNative(models: NativeModel[]): void {
		const registeredModels = models.map((model) => {
			const forceAdaptiveThinking = (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking;
			const modelBeta = getAnthropicBetaForModel(model.id, undefined, forceAdaptiveThinking);
			if (modelBeta === headers["anthropic-beta"]) return model;
			return {
				...model,
				headers: { "anthropic-beta": modelBeta, ...model.headers },
			};
		});
		// Every field is registry-visible. A catalog refresh may correct pricing,
		// effort, compatibility, or headers without changing an id/window pair.
		const signature = JSON.stringify(registeredModels);
		if (signature === lastSignature) return;
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
				models: registeredModels,
				oauth,
			});
			// Commit the signature only after the registry accepted the update. If it
			// throws, the next refresh must retry the exact same model set.
			lastSignature = signature;
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
	 *   1. the bundled snapshot — load-time fallback for a just-shipped model;
	 *   2. the persisted cache — a previous live fetch;
	 *   3. this run's live fetch — overrides the cache;
	 *   4. Pi's built-in `anthropic` catalog — authoritative where it knows the id.
	 * The bundled snapshot supplies verified pricing until Pi's catalog does;
	 * `/v1/models` omits cost, so its refresh keeps the last known price.
	 * The curated seed + user overrides are layered on by `buildNativeModels`.
	 * `ctx` is omitted at load time (before any session), when only 1–3 apply.
	 */
	function buildMergedModels(ctx?: ExtensionContext): NativeModel[] {
		const allowlist = getModelAllowlist();
		const allow = allowlist ?? ALLOWLIST_RE;
		const catalog = new Map<string, CatalogEntry>();
		const extraIds: string[] = [];
		const add = (id: string, entry: CatalogEntry): void => {
			if (!allow.test(id)) return;
			// Later sources win only for facts they actually state. In particular,
			// Pi's catalog often omits live-only capability fields; spreading explicit
			// `undefined` used to erase `supportsTemperature: false` and effort maps
			// learned from `/v1/models`. Preserve explicit boolean false: it is a
			// budget-thinking signal, while an omitted marker is not.
			const defined = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as CatalogEntry;
			const previous = catalog.get(id);
			// A newer catalog may know the price but list only part of the effort map.
			// Merge its stated keys so `off: null` from a verified adaptive-only
			// snapshot/live response is not lost; an explicit key still wins.
			const thinkingLevelMap = defined.thinkingLevelMap
				? { ...previous?.thinkingLevelMap, ...defined.thinkingLevelMap }
				: previous?.thinkingLevelMap;
			catalog.set(id, { ...previous, ...defined, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) });
			if (!extraIds.includes(id)) extraIds.push(id);
		};
		for (const m of BUNDLED_MODEL_SNAPSHOT) add(m.id, m.catalog);
		for (const m of readCachedModels()) add(m.id, m.catalog);
		for (const m of liveModels) add(m.id, m.catalog);
		if (ctx) {
			for (const model of ctx.modelRegistry.getAll()) {
				if (model.provider !== "anthropic") continue;
				// Carry everything Pi knows so an unknown family (e.g. fable) is fully derived.
				// `forceAdaptiveThinking` is authoritative here: Pi's catalog marks only the
				// models that actually support adaptive thinking (opus/sonnet 4-6+), so an older
				// discovered id (sonnet-4-5) inherits budget thinking instead of the blanket
				// family default — which the subscription route rejects with a 400.
				add(model.id, {
					cost: model.cost,
					maxTokens: model.maxTokens,
					contextWindow: model.contextWindow,
					reasoning: model.reasoning,
					input: model.input,
					thinkingLevelMap: model.thinkingLevelMap,
					// `forceAdaptiveThinking` / `supportsTemperature` live only on the Anthropic compat
					// branch; the guard above already restricts to anthropic models, so read them
					// through a narrow cast. An absent adaptive marker is NOT an explicit false:
					// Pi's catalog can lag a newer live capability snapshot. Deliberately NOT
					// carried: `supportsMidConvoEffort` (Pi
					// would then hardcode effort "high" and add a `block_binding` field genuine Claude
					// Code does not send) and `supportsStrictTools`.
					forceAdaptiveThinking: (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking,
					supportsTemperature: (model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature,
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
	 * On by default: query Anthropic's `/v1/models` with the subscription OAuth token,
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

	// Initial registration: curated seed + user overrides + bundled snapshot +
	// persisted cache. Works offline and at load time, before any session context.
	registerNative(buildMergedModels());

	// Add the missing x-anthropic-billing-header as system[0], scoped strictly to
	// this provider's OAuth requests so nothing else is ever touched.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isNativeOAuth(ctx)) return;
		const version = getClaudeCodeVersion();
		const entrypoint = getClaudeCodeEntrypoint(ctx.mode);
		// Strip third-party-harness fingerprints from the system prompt (Anthropic
		// 400s these as a disguised usage error), then add the genuine Claude Code
		// thinking display + metadata.user_id, then the billing header. Order is
		// independent: the cch hashes the first user message, not the system blocks.
		let next = sanitizeSystemPrompt(event.payload, getSanitizeRules());
		next = applyClaudeCodeIdentity(next, getClaudeCodeIdentity(ctx.mode));
		next = applyClaudeCodeThinkingDisplay(next, getClaudeCodeThinkingDisplay(ctx.mode));
		const modelId = ctx.model?.id ?? "";
		next = applyClaudeCodeMaxTokens(next, getClaudeCodeMaxTokensForModel(modelId));
		next = applyClaudeCodeBudgetThinkingProfile(next, getClaudeCodeBudgetThinkingProfileForModel(modelId));
		next = applyContextManagement(next);
		next = applyDiagnostics(next);
		next = applyMetadata(next, getClaudeUserId());
		next = applyBillingHeader(next, version, entrypoint, getSessionId());
		logNativeRequest(next, { model: ctx.model?.id, userAgent: getUserAgent(ctx.mode), version, entrypoint });
		return next === event.payload ? undefined : next;
	});

	// Genuine Claude Code sends a fresh `x-client-request-id` UUID and labels the
	// primary turn `x-claude-code-request-class: main` (re-verified across the
	// bundled print and TUI captures). Pi
	// sets this header on its OpenAI/Codex paths but not on the Anthropic one, so it
	// is the last header gap for this provider.
	//
	// Pi IGNORES this handler's return value (`emitBeforeProviderHeaders` returns the
	// object it was given), so the headers must be mutated in place. Requires Pi
	// >= 0.80.5, where the hook was introduced; `pi.on` simply never fires on older
	// versions, so nothing breaks there.
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isNativeOAuth(ctx)) return;
		event.headers["user-agent"] = getUserAgent(ctx.mode);
		const forceAdaptiveThinking = (ctx.model?.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking;
		event.headers["anthropic-beta"] = getAnthropicBetaForModel(ctx.model?.id ?? "", ctx.mode, forceAdaptiveThinking);
		event.headers["x-claude-code-request-class"] = "main";
		event.headers["x-client-request-id"] = randomUUID();
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
			const versionInfo = getClaudeCodeVersionInfo();
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
				`  cc_version:     ${versionInfo.version} (from ${VERSION_SOURCE_LABEL[versionInfo.source]})`,
				`  wire mode:      ${ctx.mode}`,
				`  cc_entrypoint:  ${getClaudeCodeEntrypoint(ctx.mode)}`,
				`  user-agent:     ${getUserAgent(ctx.mode)}`,
				`  live discovery: ${isLiveDiscoveryEnabled() ? "on" : "off"} (cache: ${readCachedModels().length} models)`,
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
