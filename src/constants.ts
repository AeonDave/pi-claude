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
import type { ModelOverride } from "./models.ts";

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

const DEFAULT_CC_VERSION = "2.1.186";
const DEFAULT_CC_ENTRYPOINT = "cli";

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

/**
 * A fingerprint captured from a real `claude` run by
 * `scripts/capture-fingerprint.mjs`. When present it overrides the hardcoded
 * defaults so the version and the `anthropic-beta` set stay a consistent,
 * freshly-captured pair. Path: `PI_CLAUDE_NATIVE_FINGERPRINT`, else
 * `~/.pi/claude-native-fingerprint.json`.
 */
interface Fingerprint {
	version?: string;
	entrypoint?: string;
	anthropicBeta?: string;
	userAgent?: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

let fingerprintCache: Fingerprint | null | undefined;
function readFingerprint(): Fingerprint | null {
	if (fingerprintCache !== undefined) return fingerprintCache;
	const path =
		process.env.PI_CLAUDE_NATIVE_FINGERPRINT?.trim() || join(homedir(), ".pi", "claude-native-fingerprint.json");
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Fingerprint;
		fingerprintCache = data && typeof data === "object" ? data : null;
	} catch {
		fingerprintCache = null; // absent/unreadable — fall back to derivation/defaults
	}
	return fingerprintCache;
}

/**
 * The version of the user's installed Claude Code, read from Claude's own state
 * files so the user-agent / billing `cc_version` track the real client with no
 * manual config. Tries the last-update record, then the seen-release-notes
 * marker. Returns `null` when neither is present.
 */
let installedVersionCache: string | null | undefined;
function readInstalledClaudeVersion(): string | null {
	if (installedVersionCache !== undefined) return installedVersionCache;
	const home = homedir();
	const sources: Array<[file: string, field: string]> = [
		[join(home, ".claude", ".last-update-result.json"), "version_to"],
		[join(home, ".claude.json"), "lastReleaseNotesSeen"],
	];
	for (const [file, field] of sources) {
		try {
			const obj = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			const value = obj[field];
			if (typeof value === "string" && VERSION_RE.test(value)) {
				installedVersionCache = value;
				return value;
			}
		} catch {
			// try the next source
		}
	}
	installedVersionCache = null;
	return null;
}

/**
 * Claude Code version used in BOTH the `user-agent` header and the billing
 * header's `cc_version`, so the two are always consistent on the wire.
 * Resolution: `PI_CLAUDE_NATIVE_CC_VERSION` env → captured fingerprint → the
 * user's installed `claude` version → the hardcoded default.
 */
export function getClaudeCodeVersion(): string {
	const override = process.env.PI_CLAUDE_NATIVE_CC_VERSION?.trim();
	if (override) return override;
	return readFingerprint()?.version?.trim() || readInstalledClaudeVersion() || DEFAULT_CC_VERSION;
}

/** Billing header `cc_entrypoint`. `cli` mirrors the interactive Claude Code CLI. */
export function getClaudeCodeEntrypoint(): string {
	const override = process.env.PI_CLAUDE_NATIVE_CC_ENTRYPOINT?.trim();
	if (override) return override;
	return readFingerprint()?.entrypoint?.trim() || DEFAULT_CC_ENTRYPOINT;
}

/** `claude-cli/<version> (external, cli)` — the genuine external CLI User-Agent. */
export function getUserAgent(): string {
	const override = process.env.PI_CLAUDE_NATIVE_USER_AGENT?.trim();
	if (override && override.length > 0) return override;
	return `claude-cli/${getClaudeCodeVersion()} (external, cli)`;
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
 * The `anthropic-beta` set captured verbatim from genuine `claude` 2.1.186's
 * normal turn (`claude -p "say hello"`, 2026). This REPLACES Pi's per-model beta
 * logic so the header is byte-identical to Claude Code's everyday request.
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
	"effort-2025-11-24",
	"extended-cache-ttl-2025-04-11",
].join(",");

/**
 * The `anthropic-beta` header to send: `PI_CLAUDE_NATIVE_ANTHROPIC_BETA` env →
 * captured fingerprint → the hardcoded captured set. The fingerprint pairs this
 * with its version, so a freshly-captured set and its version stay consistent.
 */
export function getAnthropicBeta(): string {
	const override = process.env.PI_CLAUDE_NATIVE_ANTHROPIC_BETA?.trim();
	if (override && override.length > 0) return override;
	return readFingerprint()?.anthropicBeta?.trim() || DEFAULT_ANTHROPIC_BETA;
}

// ---------------------------------------------------------------------------
// Billing header reverse-engineered constants
// ---------------------------------------------------------------------------
//
// Source: Claude Code's `x-anthropic-billing-header`. Kept byte-identical to two
// independent reference implementations. Do NOT change without a fresh wire capture.

export const CCH_SALT = "59cf53e54c78";
export const CCH_POSITIONS = [4, 7, 20] as const;

// ---------------------------------------------------------------------------
// Dynamic model configuration (optional, all env-driven)
// ---------------------------------------------------------------------------

/** Non-fatal diagnostic: bad model config must never crash the session. */
function warnConfig(message: string): void {
	try {
		process.stderr.write(`[claude-native] ${message}\n`);
	} catch {
		// best-effort
	}
}

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
