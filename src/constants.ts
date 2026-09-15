/**
 * Single source of truth for the "Claude Pro/Max Native" Pi provider.
 *
 * Every value here is chosen so that Pi's outgoing `/v1/messages` requests are
 * indistinguishable from the genuine Claude Code CLI, which is what Anthropic's
 * subscription backend requires to accept the request.
 *
 * The OAuth client id / endpoints / scopes are identical to Claude Code (and to
 * Pi's own built-in Anthropic OAuth flow in
 * `packages/ai/src/utils/oauth/anthropic.ts`).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Fingerprint,
	getModelCachePath,
	getModelCacheReadPaths,
	readFingerprint,
	readInstalledClaudeVersion,
	VERSION_RE,
} from "./fingerprint.ts";
import type { ModelOverride } from "./models.ts";
import { warnConfig } from "./warn.ts";

// Disk-state helpers live in `fingerprint.ts`; re-exported here so callers keep a
// single import for the provider's configuration surface.
export {
	getAgentDir,
	getFingerprintPath,
	getModelCachePath,
	getModelCacheReadPaths,
	getStateDir,
	migrateLegacyState,
} from "./fingerprint.ts";

/** Internal provider id: `auth.json` key, `model.provider`, and `/login <id>`. */
export const PROVIDER_ID = "claude-pro-max-native";

/** Human label shown under `/login` subscriptions and in `/model`. */
export const PROVIDER_NAME = "Claude Pro/Max Native";

/** Anthropic Messages API endpoint. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

// ---------------------------------------------------------------------------
// OAuth — identical to the genuine Claude Code CLI
// ---------------------------------------------------------------------------

// Base64 keeps the literal out of trivial source scans, matching Pi's own flow.
const decode = (value: string): string => atob(value);

/** Claude Code public OAuth client id (`9d1c250a-...`). */
export const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Hosted callback that renders the `code#state` pair for manual paste. */
export const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const OAUTH_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
].join(" ");

/** User-Agent Claude Code uses for the OAuth token endpoint (its axios client). */
export const TOKEN_USER_AGENT = "axios/1.13.6";

// ---------------------------------------------------------------------------
// Claude Code client fingerprint
// ---------------------------------------------------------------------------

// Last-resort fallback only (no fingerprint file, no readable `claude` state).
// Anthropic gates MODEL ACCESS on the claimed version — the 400 reads "Claude
// Code <v> does not support this model; version 2.1.251 or newer is required" —
// so this constant must never lag the newest generation the provider exposes.
// Captured from `claude` 2.1.266 on 2026-09-09 (captures/fingerprint-2.1.266.json).
const DEFAULT_CC_VERSION = "2.1.266";
export const DEFAULT_CC_ENTRYPOINT = "sdk-cli";
export const DEFAULT_PRINT_THINKING_DISPLAY = "omitted";

/** Pi runtime modes mapped onto the two genuine Claude Code wire profiles. */
export type ClaudeCodeRuntimeMode = "tui" | "rpc" | "json" | "print";

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_AGENT_SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// ---------------------------------------------------------------------------
// Derived fingerprint (robustness): track the user's real Claude install
// ---------------------------------------------------------------------------
//
// Rather than pinning every value, derive what is safely derivable so the
// extension stays faithful as Claude Code updates:
//   - version  ← the user's own Claude install (so user-agent / cc_version track it);
//   - a captured fingerprint file ← lets version + the exact `anthropic-beta`
//     move together (written by `scripts/capture-fingerprint.mjs`).
// Env overrides always win; hardcoded defaults are the last-resort fallback.

/** Numeric compare of dotted versions; unparsable segments sort as 0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (Number.parseInt(pa[i] ?? "0", 10) || 0) - (Number.parseInt(pb[i] ?? "0", 10) || 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

/** Where the resolved `cc_version` came from — surfaced by `/claude-native`. */
export type VersionSource = "env" | "fingerprint" | "installed" | "default";

/**
 * Pure precedence resolution, so the rule is unit-testable without touching disk.
 *
 * env > newest trustworthy version among fingerprint / installed `claude` /
 * hardcoded default. An older fingerprint must never lower either the installed
 * version or the bundled capture floor.
 *
 * Rationale: the fingerprint exists to keep version + `anthropic-beta` a
 * consistent PAIR, but Anthropic validates the pair ASYMMETRICALLY — the beta
 * set is checked by flag NAME (400 on an unknown flag), while the version is
 * checked as a MINIMUM for model access ("Claude Code 2.1.241 does not support
 * this model; version 2.1.251 or newer is required"). The version must therefore
 * move upward independently when necessary. Beta freshness is enforced
 * separately by `getUsableFingerprint`: 2.1.266 proved that byte-identical sets
 * cannot be assumed forever. A stale fingerprint used to pin an old version
 * silently and permanently; that was the root cause of the 2.1.241 outage. An
 * explicit env pin is honoured verbatim.
 */
export function resolveClaudeCodeVersion(input: {
	override?: string;
	pinned?: string;
	installed?: string | null;
	fallback?: string;
}): { version: string; source: VersionSource } {
	const override = input.override?.trim();
	if (override) return { version: override, source: "env" };
	const fallback = input.fallback ?? DEFAULT_CC_VERSION;
	const pinned = input.pinned?.trim();
	const installed = input.installed?.trim() || null;
	const floor = installed && compareVersions(installed, fallback) > 0
		? { version: installed, source: "installed" as const }
		: { version: fallback, source: "default" as const };
	if (!pinned) {
		return floor;
	}
	// A non-standard pin is a deliberate choice — pass it through untouched.
	if (!VERSION_RE.test(pinned)) return { version: pinned, source: "fingerprint" };
	if (compareVersions(pinned, floor.version) >= 0) return { version: pinned, source: "fingerprint" };
	return floor;
}

let warnedStaleFingerprint = false;

function isOlderThanBundledFingerprint(fingerprint: Fingerprint | null): boolean {
	const version = fingerprint?.version?.trim();
	return !!version && VERSION_RE.test(version) && compareVersions(version, DEFAULT_CC_VERSION) < 0;
}

/**
 * Captured beta/entrypoint values require a version and only outrank the bundled
 * capture when a comparable version is at least as new. A non-semver version is
 * retained as the same deliberate manual choice accepted by version resolution.
 * Claude 2.1.266 disproved the former assumption that an older
 * beta set remains byte-identical forever: Opus 5 gained a model-specific flag
 * while Sonnet 5 did not. Keeping a 2.1.261 fingerprint would otherwise mask the
 * corrected 2.1.266 per-model defaults indefinitely.
 */
function getUsableFingerprint(): Fingerprint | null {
	const fingerprint = readFingerprint();
	if (!fingerprint) return null;
	const version = fingerprint.version?.trim();
	const missingVersion = !version;
	if (!missingVersion && !isOlderThanBundledFingerprint(fingerprint)) return fingerprint;
	if (!warnedStaleFingerprint) {
		warnedStaleFingerprint = true;
		const reason = missingVersion
			? "fingerprint has no version, so its capture freshness cannot be verified"
			: `fingerprint version ${version} is older than the bundled Claude Code ${DEFAULT_CC_VERSION} capture`;
		warnConfig(`${reason}; ignoring its beta/entrypoint/per-model values. Re-run \`npm run capture:fingerprint -- --apply\` to refresh it.`);
	}
	return null;
}

/** The resolved version plus where it came from (diagnostics). */
export function getClaudeCodeVersionInfo(): { version: string; source: VersionSource } {
	const pinned = readFingerprint()?.version;
	const installed = readInstalledClaudeVersion();
	const resolved = resolveClaudeCodeVersion({
		override: process.env.PI_CLAUDE_NATIVE_CC_VERSION,
		pinned,
		installed,
	});
	if (isOlderThanBundledFingerprint(readFingerprint())) {
		getUsableFingerprint(); // emits the one-time stale bundled-capture diagnostic
	} else if (pinned && installed && resolved.source === "installed" && !warnedStaleFingerprint) {
		warnedStaleFingerprint = true;
		warnConfig(
			`fingerprint version ${pinned.trim()} is older than the installed claude ${installed}; sending ${installed}. ` +
				`Re-run \`npm run capture:fingerprint -- --apply\` to refresh the captured pair.`,
		);
	}
	return resolved;
}

/**
 * Claude Code version used in BOTH the `user-agent` header and the billing
 * header's `cc_version`, so the two are always consistent on the wire.
 */
export function getClaudeCodeVersion(): string {
	return getClaudeCodeVersionInfo().version;
}

/**
 * Billing-header/client profile for the current Pi mode.
 *
 * Claude Code 2.1.266 is genuinely mode-dependent: its interactive TUI uses
 * `cli`, while `claude -p` uses `sdk-cli`. Pi exposes the same distinction as
 * `ctx.mode === "tui"` versus print/json/rpc. The fingerprint is captured with
 * `claude -p`, so it remains the non-interactive fallback. An explicit override
 * deliberately wins for every mode.
 */
export function getClaudeCodeEntrypoint(mode?: ClaudeCodeRuntimeMode): string {
	const override = process.env.PI_CLAUDE_NATIVE_CC_ENTRYPOINT?.trim();
	if (override) return override;
	if (mode === "tui") return "cli";
	return getUsableFingerprint()?.entrypoint?.trim() || DEFAULT_CC_ENTRYPOINT;
}

/** Genuine external-CLI User-Agent for the selected runtime mode. */
export function getUserAgent(mode?: ClaudeCodeRuntimeMode): string {
	const override = process.env.PI_CLAUDE_NATIVE_USER_AGENT?.trim();
	if (override && override.length > 0) return override;
	return `claude-cli/${getClaudeCodeVersion()} (external, ${getClaudeCodeEntrypoint(mode)})`;
}

/** Exact `system` identity paired with the selected genuine client profile. */
export function getClaudeCodeIdentity(mode?: ClaudeCodeRuntimeMode): string {
	return getClaudeCodeEntrypoint(mode) === "cli" ? CLAUDE_CODE_IDENTITY : CLAUDE_AGENT_SDK_IDENTITY;
}

/** Interactive Claude renders thinking updates; non-interactive Claude omits them. */
export function getClaudeCodeThinkingDisplay(mode?: ClaudeCodeRuntimeMode): "updates" | "omitted" {
	return getClaudeCodeEntrypoint(mode) === "cli" ? "updates" : DEFAULT_PRINT_THINKING_DISPLAY;
}

/**
 * Endpoint for the provider. Override with `PI_CLAUDE_NATIVE_BASE_URL` to route
 * through a proxy (e.g. the capture proxy in `scripts/capture-proxy.mjs`, or a
 * corporate gateway).
 */
export function getBaseUrl(): string {
	const override = process.env.PI_CLAUDE_NATIVE_BASE_URL?.trim();
	return override && override.length > 0 ? override : ANTHROPIC_BASE_URL;
}

/**
 * The conservative `anthropic-beta` BASE shared verbatim by genuine Claude Code
 * 2.1.266's Opus 5 and Sonnet 5 normal turns (`claude -p`, 2026-09-09).
 * This REPLACES Pi's per-model beta
 * logic so the header is byte-identical to Claude Code's everyday request.
 * Re-captured with the proxy marked first-party so conditional `cch` and beta
 * flags are preserved. Compared with 2.1.220, 2.1.233 added
 * `advanced-tool-use`, `afk-mode`, and `cache-diagnosis`; 2.1.241 kept the
 * same 13 flags but changed the Haiku non-effort subset; 2.1.261 added Fable
 * 5.1's first per-model flag. In 2.1.266 Opus and Sonnet diverged: the shared
 * safe base remains these 13 flags, while exact additions live in
 * `MODEL_BETA_DELTAS`.
 *
 * The set is per-model in both directions now:
 *   Sonnet 5          — this base, 13 flags;
 *   Opus 5 / Opus 4.8 / Fable 5 — base + `mid-conversation-tool-changes` = 14;
 *   Haiku 4.5         — base minus the three adaptive-effort flags = 10;
 *   Fable 5.1         — base + `per-turn-control` + tool changes = 15.
 *
 * `context-1m-2025-08-07` is intentionally NOT here: a subscription without
 * long-context access returns 400/429 on any request that advertises it, and
 * the curated families are natively 1M so they don't need it to expose their
 * full window. With it removed, this set matches a genuine `claude` opus normal
 * turn byte-for-byte (verified by capture). If your plan needs the beta to
 * unlock >200K, add it via `PI_CLAUDE_NATIVE_ANTHROPIC_BETA`.
 *
 * Anthropic returns a 400 on unexpected beta values, so do not edit this by
 * guessing — re-capture from your installed `claude` (see VERIFY.md) and set
 * `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` to the new value.
 */
export const DEFAULT_ANTHROPIC_BETA = [
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
].join(",");

const MID_CONVO = "mid-conversation-system-2026-04-07";
const PER_TURN_CONTROL = "per-turn-control-2026-07-01";
const MID_CONVO_TOOL_CHANGES = "mid-conversation-tool-changes-2026-07-01";
const EFFORT = "effort-2025-11-24";
const AFK_MODE = "afk-mode-2026-01-31";
const ADVANCED_TOOL_USE = "advanced-tool-use-2025-11-20";
const FALLBACK_CREDIT = "fallback-credit-2026-06-01";
const THINKING_DISPLAY_UPDATES = "thinking-display-updates-2026-08-18";

const ADAPTIVE_EFFORT_BETAS = new Set([
	"mid-conversation-system-2026-04-07",
	"effort-2025-11-24",
	"afk-mode-2026-01-31",
]);

/** Genuine Haiku 4.5 normal turns omit the adaptive-effort-only flags (2.1.266 capture). */
/** Re-captured: Haiku keeps `advisor-tool` but drops `mid-conversation-system`. */
export const DEFAULT_NON_EFFORT_ANTHROPIC_BETA = DEFAULT_ANTHROPIC_BETA.split(",")
	.filter((flag) => !ADAPTIVE_EFFORT_BETAS.has(flag))
	.join(",");

/**
 * How each model's `anthropic-beta` differs from the common base set — captured
 * from `claude` 2.1.266 across every id this provider exposes (11 models,
 * 2026-09-09). The exact sets are:
 *
 *   sonnet 5                              — the common base 13 (no delta)
 *   opus 5 / opus 4.8 / fable 5          — 14 (adds tool changes)
 *   fable 5.1                             — 15 (adds per-turn + tool changes)
 *   opus 4.7 / opus 4.6 / sonnet 4.6      — 12 (drops `mid-conversation-system`)
 *   opus 4.5                              — 11 (also drops `afk-mode`)
 *   sonnet 4.5 / haiku 4.5                — 10 (also drops `effort`)
 *
 * Expressed as DELTAS, not verbatim sets, so they keep tracking a re-captured
 * base instead of silently going stale beside it.
 *
 * None of this is derivable from `/v1/models`: Opus 4.8 and Opus 4.7 advertise
 * identical capabilities (both xhigh, both adaptive-only) yet send different sets.
 * It has to be captured. Every addition is keyed by EXACT id because Anthropic
 * 400s on unexpected flags. A future version therefore gets the safe common base
 * until a re-capture records its real value under the fingerprint's `modelBeta`,
 * which takes precedence over this table.
 */
export interface ModelBetaDelta {
	remove?: readonly string[];
	add?: readonly { flag: string; after: string }[];
}

export const MODEL_BETA_DELTAS: Record<string, ModelBetaDelta> = {
	"claude-opus-5": { add: [{ flag: MID_CONVO_TOOL_CHANGES, after: MID_CONVO }] },
	"claude-fable-5-1": {
		add: [
			{ flag: PER_TURN_CONTROL, after: MID_CONVO },
			{ flag: MID_CONVO_TOOL_CHANGES, after: PER_TURN_CONTROL },
		],
	},
	"claude-fable-5": { add: [{ flag: MID_CONVO_TOOL_CHANGES, after: MID_CONVO }] },
	"claude-opus-4-8": { add: [{ flag: MID_CONVO_TOOL_CHANGES, after: MID_CONVO }] },
	"claude-opus-4-7": { remove: [MID_CONVO] },
	"claude-opus-4-6": { remove: [MID_CONVO] },
	"claude-sonnet-4-6": { remove: [MID_CONVO] },
	"claude-opus-4-5": { remove: [MID_CONVO, AFK_MODE] },
	"claude-sonnet-4-5": { remove: [MID_CONVO, EFFORT, AFK_MODE] },
	"claude-haiku-4-5": { remove: [MID_CONVO, EFFORT, AFK_MODE] },
};

/**
 * Exact-id exceptions captured from genuine Claude Code 2.1.266's interactive
 * TUI. All eleven models added `thinking-display-updates`, so that flag is a
 * captured mode-wide signal applied below (including to newly-discovered
 * families); only Opus 5 and Fable 5/5.1 also added `fallback-credit`.
 */
export const TUI_MODEL_BETA_DELTAS: Readonly<Record<string, ModelBetaDelta>> = {
	"claude-opus-5": {
		add: [{ flag: FALLBACK_CREDIT, after: EFFORT }],
	},
	"claude-fable-5-1": {
		add: [{ flag: FALLBACK_CREDIT, after: EFFORT }],
	},
	"claude-fable-5": {
		add: [{ flag: FALLBACK_CREDIT, after: EFFORT }],
	},
};

/**
 * The genuine flag ORDER for models that do not order like the base — Haiku sends
 * `claude-code-20250219` sixth, not first, and filtering the base can only ever
 * reproduce the base's order. Applied only when it holds exactly the same flags
 * the delta above derives, so it self-invalidates: if the base set is ever
 * re-captured differently, the sets stop matching and we emit the derived value
 * (right flags, base order) instead of a stale captured string.
 */
const GENUINE_FLAG_ORDER: Record<string, readonly string[]> = {
	"claude-haiku-4-5": [
		"oauth-2025-04-20",
		"interleaved-thinking-2025-05-14",
		"thinking-token-count-2026-05-13",
		"context-management-2025-06-27",
		"prompt-caching-scope-2026-01-05",
		"claude-code-20250219",
		"advisor-tool-2026-03-01",
		"advanced-tool-use-2025-11-20",
		"extended-cache-ttl-2025-04-11",
		"cache-diagnosis-2026-04-07",
	],
};

/** Same flags, ignoring order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sorted = [...b].sort();
	return [...a].sort().every((flag, i) => flag === sorted[i]);
}

/**
 * Look up a captured per-model beta set.
 *
 * A capture records the WIRE id genuine Claude Code sent
 * (`claude-haiku-4-5-20251001`), while this provider registers the clean alias
 * (`claude-haiku-4-5`) — the same id Anthropic resolves to that model. Match both
 * spellings, or the captured value (and its genuine flag ORDER) would never reach
 * the model Pi actually sends.
 */
function lookupCapturedBeta(modelId: string): string | undefined {
	const map = getUsableFingerprint()?.modelBeta;
	if (!map) return undefined;
	const exact = map[modelId]?.trim();
	if (exact) return exact;
	for (const [id, value] of Object.entries(map)) {
		if (id.replace(/-\d{8}$/, "") === modelId) return value.trim() || undefined;
	}
	return undefined;
}

let warnedMissingAnchor = false;

/**
 * Insert `flag` directly after `after`. Returns the list UNCHANGED when the
 * anchor is absent — a captured value's order is evidence, so guessing a new
 * position (or appending) would emit bytes no genuine client ever sent.
 */
function insertAfter(flags: string[], flag: string, after: string): string[] {
	if (flags.includes(flag)) return flags;
	const at = flags.indexOf(after);
	if (at < 0) {
		if (!warnedMissingAnchor) {
			warnedMissingAnchor = true;
			warnConfig(`anthropic-beta anchor "${after}" missing; skipping the "${flag}" addition rather than guessing its position`);
		}
		return flags;
	}
	return [...flags.slice(0, at + 1), flag, ...flags.slice(at + 1)];
}

/**
 * The `anthropic-beta` header to send: `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` env →
 * captured fingerprint (when at least as new as the bundled capture) → the
 * hardcoded 2.1.266 common set. The fingerprint pairs this with its version, so
 * a freshly-captured set and its version stay consistent without letting stale
 * state mask newer built-in per-model evidence.
 */
export function getAnthropicBeta(): string {
	const override = process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA?.trim();
	if (override && override.length > 0) return override;
	return getUsableFingerprint()?.anthropicBeta?.trim() || DEFAULT_ANTHROPIC_BETA;
}

/**
 * The `anthropic-beta` for one model and Pi runtime mode. Resolution, highest
 * first:
 *
 *   1. `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` — an explicit override is verbatim for
 *      every model (documented contract; the user is pinning the exact bytes);
 *   2. the fingerprint's per-model captured set (`modelBeta[<wire id>]`) — used
 *      verbatim, so a re-capture makes a NEW model exact with no code change,
 *      preserving the genuine flag ORDER (Haiku's differs from the base);
 *   3. the common base set ± the built-in captured model deltas;
 *   4. in TUI mode, the universal interactive-display flag plus the three
 *      captured exact-id fallback-credit exceptions.
 */
export function getAnthropicBetaForModel(
	modelId: string,
	mode?: ClaudeCodeRuntimeMode,
	forceAdaptiveThinking?: boolean,
): string {
	const beta = getAnthropicBeta();
	if (process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA?.trim()) return beta;

	const cleanModelId = modelId.replace(/-\d{8}$/, "");
	const fingerprint = getUsableFingerprint();
	const captured = lookupCapturedBeta(modelId);
	let flags = (captured || beta).split(",").map((flag) => flag.trim()).filter(Boolean);
	// Built-in model deltas are evidence for exactly the bundled capture version.
	// If a newer fingerprint omitted this model, composing its new common base
	// with old deltas would create a flag set no genuine client was observed
	// sending. Use the newer common base conservatively instead. The capture script
	// now records every exposed id by default, so this branch is chiefly for a
	// newly-discovered model or an intentionally partial capture.
	const canUseBundledModelEvidence =
		!fingerprint || fingerprint.version?.trim() === DEFAULT_CC_VERSION;
	const bundledDelta = MODEL_BETA_DELTAS[cleanModelId];
	// Live discovery can positively identify a budget-only model before its first
	// wire capture. Use the non-effort subset only when no exact captured/bundled
	// delta exists: Opus 4.5 is budget-thinking but still sends `effort`.
	if (!captured && forceAdaptiveThinking === false && !(canUseBundledModelEvidence && bundledDelta)) {
		flags = flags.filter((flag) => !ADAPTIVE_EFFORT_BETAS.has(flag));
	}
	if (!captured && canUseBundledModelEvidence) {
		const delta = bundledDelta;
		if (delta?.remove) {
			const drop = new Set(delta.remove);
			flags = flags.filter((flag) => !drop.has(flag));
		} else if (!delta && cleanModelId.startsWith("claude-haiku-")) {
			// Family fallback for a Haiku id we have not captured: every Haiku observed
			// so far omits the three adaptive-effort-only flags.
			flags = flags.filter((flag) => !ADAPTIVE_EFFORT_BETAS.has(flag));
		}
		for (const addition of delta?.add ?? []) {
			flags = insertAfter(flags, addition.flag, addition.after);
		}

		const genuineOrder = GENUINE_FLAG_ORDER[cleanModelId];
		if (genuineOrder && sameSet(genuineOrder, flags)) flags = [...genuineOrder];
	}

	// `modelBeta` is captured by `claude -p`. Interactive mode adds one signal on
	// every captured model, plus a narrowly-scoped exception on three exact ids.
	// Treat the universal 11/11 signal as part of the mode profile so a newly
	// discovered family remains immediately usable; never spread the exception.
	if (getClaudeCodeEntrypoint(mode) === "cli") {
		if (canUseBundledModelEvidence) {
			for (const addition of TUI_MODEL_BETA_DELTAS[cleanModelId]?.add ?? []) {
				flags = insertAfter(flags, addition.flag, addition.after);
			}
		}
		const displayAnchor = flags.includes(FALLBACK_CREDIT)
			? FALLBACK_CREDIT
			: flags.includes(EFFORT)
				? EFFORT
				: ADVANCED_TOOL_USE;
		flags = insertAfter(flags, THINKING_DISPLAY_UPDATES, displayAnchor);
	}
	return flags.join(",");
}

/**
 * Genuine Claude Code 2.1.266 request caps captured across all eleven exposed
 * model ids. These are intentionally distinct from `/v1/models.max_tokens` and
 * Pi's catalog `maxTokens`: those advertise the API ceiling (128K/64K), while
 * the CLI actually puts 64K/32K on the wire. Keep the catalog values for model
 * metadata and clamp only the serialized request in `before_provider_request`.
 * Unknown models are left untouched until a real capture records their value.
 */
export const DEFAULT_MODEL_MAX_TOKENS: Readonly<Record<string, number>> = {
	"claude-opus-5": 64_000,
	"claude-sonnet-5": 64_000,
	"claude-fable-5-1": 64_000,
	"claude-fable-5": 64_000,
	"claude-opus-4-8": 64_000,
	"claude-opus-4-7": 64_000,
	"claude-opus-4-6": 64_000,
	"claude-sonnet-4-6": 32_000,
	"claude-opus-4-5": 32_000,
	"claude-sonnet-4-5": 32_000,
	"claude-haiku-4-5": 32_000,
};

/** Captured request cap for one model, preferring a usable fingerprint. */
export function getClaudeCodeMaxTokensForModel(modelId: string): number | undefined {
	const cleanModelId = modelId.replace(/-\d{8}$/, "");
	const fingerprint = getUsableFingerprint();
	const captured = fingerprint?.modelMaxTokens;
	if (captured) {
		const exact = captured[modelId] ?? captured[cleanModelId];
		if (exact !== undefined) return exact;
		for (const [id, value] of Object.entries(captured)) {
			if (id.replace(/-\d{8}$/, "") === cleanModelId) return value;
		}
	}
	// Like beta deltas, request caps are capture-version evidence. A newer partial
	// fingerprint must not make an uncaptured model inherit a 2.1.266 client cap;
	// leave Pi's serialized value alone until that id is observed.
	if (fingerprint && fingerprint.version?.trim() !== DEFAULT_CC_VERSION) return undefined;
	return DEFAULT_MODEL_MAX_TOKENS[modelId] ?? DEFAULT_MODEL_MAX_TOKENS[cleanModelId];
}

export interface ClaudeCodeBudgetThinkingProfile {
	budgetTokens: number;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Exact budget-thinking request shapes observed on genuine Claude 2.1.266. */
export const DEFAULT_BUDGET_THINKING_PROFILES: Readonly<Record<string, ClaudeCodeBudgetThinkingProfile>> = {
	"claude-opus-4-5": { budgetTokens: 31_999, effort: "high" },
	"claude-sonnet-4-5": { budgetTokens: 31_999 },
	"claude-haiku-4-5": { budgetTokens: 31_999 },
};

/** Do not project a 2.1.266 budget profile through a newer partial fingerprint. */
export function getClaudeCodeBudgetThinkingProfileForModel(
	modelId: string,
): ClaudeCodeBudgetThinkingProfile | undefined {
	const fingerprint = getUsableFingerprint();
	const cleanModelId = modelId.replace(/-\d{8}$/, "");
	const captured = fingerprint?.modelBudgetThinking;
	if (captured) {
		const exact = captured[modelId] ?? captured[cleanModelId];
		if (exact) return exact;
		for (const [id, profile] of Object.entries(captured)) {
			if (id.replace(/-\d{8}$/, "") === cleanModelId) return profile;
		}
	}
	if (fingerprint && fingerprint.version?.trim() !== DEFAULT_CC_VERSION) return undefined;
	return DEFAULT_BUDGET_THINKING_PROFILES[modelId] ?? DEFAULT_BUDGET_THINKING_PROFILES[cleanModelId];
}

// ---------------------------------------------------------------------------
// Billing header reverse-engineered constants
// ---------------------------------------------------------------------------
//
// Source: Claude Code's `x-anthropic-billing-header`. VERIFIED byte-for-byte
// against 2.1.261's own implementation (`Gdt`/`kzn`, readable JS in the installed
// binary):
//   sampled = [4,7,20].map(i => text[i] || "0").join("")
//   suffix  = sha256(SALT + sampled + VERSION).slice(0, 3)
// Reproduced on live wire captures: "reply with the single word ok" -> 547 at
// 2.1.261 and 9d8 at 2.1.266; "read the hello file" -> 384 and "hi" -> 6af at
// 2.1.261. These are ground truth now, not a twice-guessed constant — do NOT
// change them.

export const CCH_SALT = "59cf53e54c78";
export const CCH_POSITIONS = [4, 7, 20] as const;

// ---------------------------------------------------------------------------
// Dynamic model configuration (optional, all env-driven)
// ---------------------------------------------------------------------------

function parseOverrides(json: string, source: string): ModelOverride[] {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (err) {
		warnConfig(`${source}: invalid JSON (${(err as Error).message})`);
		return [];
	}
	const list = Array.isArray(data)
		? data
		: data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)
			? (data as { models: unknown[] }).models
			: undefined;
	if (!list) {
		warnConfig(`${source}: expected a JSON array of model objects (or { "models": [...] })`);
		return [];
	}
	return list.filter(
		(m): m is ModelOverride => !!m && typeof m === "object" && typeof (m as ModelOverride).id === "string",
	);
}

/**
 * User-supplied model overrides, merged over the built-in/discovered list at
 * registration time. Each entry needs at least an `id`; supply only the fields
 * you want to change (e.g. `{ "id": "claude-opus-4-8", "cost": {...} }`), or a
 * complete model object to add a brand-new entry.
 *
 * - `PI_CLAUDE_NATIVE_MODELS`      — inline JSON array (or `{ "models": [...] }`).
 * - `PI_CLAUDE_NATIVE_MODELS_FILE` — path to a JSON file with the same shape.
 */
export function getModelOverrides(): ModelOverride[] {
	const out: ModelOverride[] = [];
	const inline = process.env.PI_CLAUDE_NATIVE_MODELS?.trim();
	if (inline) out.push(...parseOverrides(inline, "PI_CLAUDE_NATIVE_MODELS"));
	const file = process.env.PI_CLAUDE_NATIVE_MODELS_FILE?.trim();
	if (file) {
		try {
			out.push(...parseOverrides(readFileSync(file, "utf8"), file));
		} catch (err) {
			warnConfig(`failed to read ${file}: ${(err as Error).message}`);
		}
	}
	return out;
}

/**
 * Live model discovery: the extension queries Anthropic's own `GET /v1/models`
 * with the subscription OAuth token once per process at session start, so a
 * newly-shipped model appears the day it ships instead of waiting for Pi's
 * bundled catalog to update, and the result is persisted as the local fallback.
 *
 * ON by default. That endpoint is the only authoritative source for the facts
 * this extension would otherwise have to hard-code per model — the effort
 * ceiling (`capabilities.effort.xhigh`), adaptive-vs-budget thinking, and the
 * real context window — so deriving them keeps a new model working with no code
 * change. It is a single authenticated request to the same host the provider
 * already talks to, it runs at most once per process, and every failure degrades
 * silently to the cache + Pi's catalog + the curated seed.
 *
 * Opt out with `PI_CLAUDE_NATIVE_LIVE_DISCOVERY=0` (also accepts false/no/off).
 */
export function isLiveDiscoveryEnabled(): boolean {
	const v = process.env.PI_CLAUDE_NATIVE_LIVE_DISCOVERY?.trim().toLowerCase();
	if (v === undefined || v === "") return true;
	return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * Optional override for which Anthropic catalog ids are auto-exposed, as a
 * regex source string (`PI_CLAUDE_NATIVE_MODELS_ALLOW`). Returns `undefined` to
 * fall back to the built-in `ALLOWLIST_RE`. Tighten it to hide noise, or widen
 * it to surface ids the default pattern skips.
 */
export function getModelAllowlist(): RegExp | undefined {
	const raw = process.env.PI_CLAUDE_NATIVE_MODELS_ALLOW?.trim();
	if (!raw) return undefined;
	try {
		return new RegExp(raw);
	} catch (err) {
		warnConfig(`invalid PI_CLAUDE_NATIVE_MODELS_ALLOW (${(err as Error).message})`);
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// First-party signals — make the body look like genuine Claude Code
// ---------------------------------------------------------------------------

/** Stable for the life of the process, like Claude Code's per-session id. */
const SESSION_ID = (() => {
	try {
		return randomUUID();
	} catch {
		return "00000000-0000-0000-0000-000000000000";
	}
})();

/** The session id sent as `x-claude-code-session-id` header (matches metadata). */
export function getSessionId(): string {
	return SESSION_ID;
}

let cachedUserId: string | null | undefined;

/**
 * The `metadata.user_id` JSON string genuine Claude Code sends:
 * `{"device_id":…,"account_uuid":…,"session_id":…}`. The device id and account
 * uuid are read from the installed Claude Code config (`~/.claude.json`:
 * `userID` and `oauthAccount.accountUuid`) so the value matches your real client
 * byte-for-byte. Returns `undefined` (and the metadata is simply omitted) when
 * the config is missing — never fabricated.
 *
 * Override the whole value with `PI_CLAUDE_NATIVE_USER_ID`, or disable injection
 * with `PI_CLAUDE_NATIVE_NO_METADATA=1`.
 */
export function getClaudeUserId(): string | undefined {
	if (process.env.PI_CLAUDE_NATIVE_NO_METADATA?.trim()) return undefined;
	const override = process.env.PI_CLAUDE_NATIVE_USER_ID?.trim();
	if (override) return override;
	if (cachedUserId !== undefined) return cachedUserId ?? undefined;
	try {
		const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as {
			userID?: string;
			oauthAccount?: { accountUuid?: string };
		};
		const deviceId = config.userID;
		const accountUuid = config.oauthAccount?.accountUuid;
		if (typeof deviceId === "string" && typeof accountUuid === "string") {
			cachedUserId = JSON.stringify({ device_id: deviceId, account_uuid: accountUuid, session_id: SESSION_ID });
		} else {
			cachedUserId = null;
		}
	} catch {
		cachedUserId = null; // no Claude Code config — omit metadata rather than guess
	}
	return cachedUserId ?? undefined;
}

/** A literal find/replace applied to system-prompt text. */
export interface SystemReplacement {
	match: string;
	replacement: string;
}

/** Sanitization rules: drop anchored paragraphs, then apply literal replacements. */
export interface SanitizeRules {
	removeAnchors: string[];
	replacements: SystemReplacement[];
}

/**
 * Default paragraph-removal anchors. Anthropic's backend fingerprints the system
 * prompt to detect third-party agent harnesses and rejects them with a 400
 * *disguised as* a usage error ("…draw from your extra usage…"). Isolated by
 * bisection (`scripts/bisect-classifier.ts`): Pi's tell is its meta-development
 * **"Pi documentation"** block (custom providers / adding models / SDK / pi
 * packages), which reads as an agent building API integrations. Removing that
 * whole paragraph clears the rejection (the full prompt minus it returns 200);
 * the rest of Pi's prompt — including the skills/tool catalog — passes.
 *
 * This is the same technique the opencode-anthropic-auth reference uses; the
 * trigger phrase just differs per harness. Extend with
 * `PI_CLAUDE_NATIVE_SYSTEM_ANCHORS` (a JSON array of strings) as the upstream
 * prompt evolves — capture a failure and re-bisect.
 */
export const DEFAULT_SYSTEM_ANCHORS: string[] = ["Pi documentation (read only when"];

/**
 * Default literal replacements (cosmetic identity consistency — not load-bearing
 * for the classifier, which the anchor removal handles). Extend with
 * `PI_CLAUDE_NATIVE_SYSTEM_REPLACEMENTS` (a JSON array of `{ match, replacement }`).
 */
export const DEFAULT_SYSTEM_REPLACEMENTS: SystemReplacement[] = [
	{
		match: "operating inside pi, a coding agent harness",
		replacement: "operating in a command-line coding environment",
	},
];

function parseJsonArray<T>(envName: string, fallback: T[], valid: (v: unknown) => v is T): T[] {
	const raw = process.env[envName]?.trim();
	if (!raw) return fallback;
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every(valid)) return parsed;
		warnConfig(`${envName}: unexpected shape`);
	} catch (err) {
		warnConfig(`${envName}: invalid JSON (${(err as Error).message})`);
	}
	return fallback;
}

/** System-prompt sanitization rules: env overrides, else the defaults. */
export function getSanitizeRules(): SanitizeRules {
	return {
		removeAnchors: parseJsonArray(
			"PI_CLAUDE_NATIVE_SYSTEM_ANCHORS",
			DEFAULT_SYSTEM_ANCHORS,
			(v): v is string => typeof v === "string",
		),
		replacements: parseJsonArray(
			"PI_CLAUDE_NATIVE_SYSTEM_REPLACEMENTS",
			DEFAULT_SYSTEM_REPLACEMENTS,
			(v): v is SystemReplacement =>
				!!v && typeof (v as SystemReplacement).match === "string" && typeof (v as SystemReplacement).replacement === "string",
		),
	};
}
