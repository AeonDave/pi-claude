/**
 * Models exposed by the "Claude Pro/Max Native" provider.
 *
 * IDs and parameters mirror Pi's canonical Anthropic models
 * (`packages/ai/src/providers/anthropic.models.ts`) so thinking, caching and
 * cost tracking behave identically. The subscription serves whichever of these
 * your plan grants; selecting an ungranted model simply errors at request time.
 *
 * The list is built, not hand-written, from three layers (see `buildNativeModels`):
 *
 *   1. a curated SEED of known ids (always present — works offline / at load);
 *   2. extra ids discovered at runtime from Pi's built-in `anthropic` catalog
 *      (`ctx.modelRegistry.getAll()`), so a newly-shipped Claude appears on its
 *      own without editing this file; and
 *   3. user overrides from `PI_CLAUDE_NATIVE_MODELS` / `…_FILE` (highest priority).
 *
 * Discovery is family-AGNOSTIC: the allowlist accepts any `claude-<family>-<ver>`
 * id, so a newly-shipped family (e.g. `claude-fable-5`, `claude-mythos-1-0`)
 * appears on its own the moment Pi's catalog lists it — no edit here. Curated
 * families (opus/sonnet/haiku) keep their pinned cost/effort/context window for
 * fidelity; for any other family everything (cost, window, effort) is *derived*
 * from Pi's catalog entry as a single conservative entry.
 *
 * Effort: the adaptive models send `output_config.effort` derived from Pi's
 * thinking level via `thinkingLevelMap`. Wire effort values are
 * low/medium/high/xhigh/max — Opus 4.8/4.7 support xhigh, Opus 4.6/Sonnet 4.6
 * top out at max (so xhigh maps to max), Haiku 4.5 has no effort (budget
 * thinking only). "ultracode" is a Claude Code UI label (xhigh + multi-agent
 * permission), not a wire value, so it is intentionally absent.
 *
 * 1M context: Opus 4.8/4.7/4.6 and Sonnet 4.6 are natively 1M, so each is a
 * single entry exposing its full window under its clean id — no `[1m]` wire
 * suffix and no `…-1m` opt-in alias. (The old suffix produced an invalid wire
 * id like `claude-opus-4-8[1m]`, which Anthropic rejects with a 404; and the
 * `context-1m-2025-08-07` beta is deliberately not advertised, so a plan
 * without long-context access is never tripped into a 400/429.)
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export interface NativeModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: Model<Api>["compat"];
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Per-model request headers, merged at registration (e.g. from a `PI_CLAUDE_NATIVE_MODELS` override). */
	headers?: Record<string, string>;
}

/** A user/runtime model override: an `id` plus any subset of fields to merge. */
export type ModelOverride = Partial<NativeModel> & { id: string };

/**
 * What Pi's built-in `anthropic` catalog tells us about a discovered model.
 * Everything here is *derived* (not guessed): for a model id we don't curate, we
 * carry its real cost / window / effort straight from Pi's catalog so a new
 * family (e.g. `claude-fable-5`) works without editing this file.
 */
export interface CatalogEntry {
	cost?: NativeModel["cost"];
	maxTokens?: number;
	contextWindow?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}

/** Curated families: their effort ceiling, cost, and context policy are pinned. */
type KnownFamily = "opus" | "sonnet" | "haiku";

/** How a family maps to context-window entries. */
type ContextPolicy =
	| "single-1m" // a single entry at the model's native 1M window
	| "single-200k"; // a single entry at 200K

interface FamilyDefault {
	cost: NativeModel["cost"];
	maxTokens: number;
	compat?: Model<Api>["compat"];
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	context: ContextPolicy;
}

/**
 * Coarse gate for ids we may expose: a Claude family name plus a 1- or 2-segment
 * numeric version, e.g. `claude-opus-4-8`, `claude-fable-5`, `claude-mythos-1-0`.
 * Deliberately family-AGNOSTIC so a newly-shipped family appears on its own.
 * Rejects dated ids (`…-20250805`), dotted aliases (`claude-opus-4.8`), the
 * legacy `claude-3-*`, and our own `…-1m` alias marker. `parseModelId` then adds
 * the precise rule (known families require a minor, to skip bare legacy ids).
 */
export const ALLOWLIST_RE = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/;

/** Fallback cost for an unknown family with no catalog cost (display only). */
const FALLBACK_COST: NativeModel["cost"] = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** Per-tier defaults for everything that is constant within a curated family. */
const FAMILY_DEFAULTS: Record<KnownFamily, FamilyDefault> = {
	opus: {
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		maxTokens: 128000,
		compat: { forceAdaptiveThinking: true },
		thinkingLevelMap: { xhigh: "max" },
		context: "single-1m",
	},
	sonnet: {
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 64000,
		compat: { forceAdaptiveThinking: true },
		context: "single-1m",
	},
	haiku: {
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		maxTokens: 64000,
		context: "single-200k",
	},
};

function isKnownFamily(family: string): family is KnownFamily {
	return Object.hasOwn(FAMILY_DEFAULTS, family);
}

/**
 * Parse a model id into `{ family, versionLabel }`, or `null` if it should not be
 * exposed. Known families (`opus`/`sonnet`/`haiku`) require a `major-minor`
 * version so bare legacy ids like `claude-opus-4` are skipped; other families
 * accept a 1- or 2-segment version so `claude-fable-5` and `claude-mythos-1-0`
 * both pass.
 */
export function parseModelId(id: string): { family: string; versionLabel: string } | null {
	const match = ALLOWLIST_RE.exec(id);
	if (!match) return null;
	const family = match[1];
	const version = match[2]; // "4-8" | "5" | "4" | "4-20250514"
	const segments = version.split("-");
	// Reject date-like segments (e.g. `claude-opus-4-20250514`); real versions are
	// 1–2 digits, dated aliases are 8. Anything ≥4 digits is not a version.
	if (segments.some((s) => s.length >= 4)) return null;
	if (isKnownFamily(family) && segments.length < 2) return null; // skip bare legacy ids
	return { family, versionLabel: version.replace(/-/g, ".") };
}

/**
 * Per-id refinements of the family default, for facts that are not derivable
 * (which models genuinely support the higher `xhigh` effort, and which disable
 * temperature). Anything not listed here inherits the conservative family
 * default. Re-capture before claiming a new id supports `xhigh`.
 */
const ID_OVERRIDES: Record<string, Pick<NativeModel, "compat" | "thinkingLevelMap">> = {
	"claude-opus-4-8": {
		compat: { forceAdaptiveThinking: true, supportsTemperature: false },
		thinkingLevelMap: { xhigh: "xhigh" },
	},
	"claude-opus-4-7": {
		compat: { forceAdaptiveThinking: true, supportsTemperature: false },
		thinkingLevelMap: { xhigh: "xhigh" },
	},
};

/**
 * The curated set of ids always exposed, regardless of runtime discovery, so the
 * provider is fully usable offline and at load time (before `ctx` exists).
 */
export const SEED_IDS = [
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
] as const;

function displayName(family: string, versionLabel: string): string {
	const fam = family.charAt(0).toUpperCase() + family.slice(1);
	return `Claude ${fam} ${versionLabel}`;
}

/**
 * Expand a single id into its native model entry. Known families use their
 * curated `FAMILY_DEFAULTS` (+ any `ID_OVERRIDES`), so the seed is byte-stable;
 * unknown families (e.g. `fable`) derive cost / window / effort straight from
 * Pi's catalog. Every family yields a single entry at its native window (opus/
 * sonnet 1M, haiku 200K, unknown → catalog). Returns `[]` for ids that should
 * not be exposed.
 */
function buildFamilyModels(id: string, fromCatalog?: CatalogEntry): NativeModel[] {
	const parsed = parseModelId(id);
	if (!parsed) return [];
	const { family, versionLabel } = parsed;
	const known = isKnownFamily(family) ? FAMILY_DEFAULTS[family] : undefined;
	const overlay = ID_OVERRIDES[id];

	const cost = fromCatalog?.cost ?? known?.cost ?? FALLBACK_COST;
	const maxTokens = fromCatalog?.maxTokens ?? known?.maxTokens ?? 64000;
	const reasoning = fromCatalog?.reasoning ?? true;
	const input = fromCatalog?.input ?? ["text", "image"];
	// Known families keep their exact curated compat (haiku intentionally has none);
	// unknown families default to adaptive thinking when they reason.
	const compat = overlay?.compat ?? known?.compat ?? (known || !reasoning ? undefined : { forceAdaptiveThinking: true });
	// Known families keep their curated effort ceiling; unknown families derive it
	// from the catalog (the only honest source for a model we don't curate).
	const thinkingLevelMap = overlay?.thinkingLevelMap ?? known?.thinkingLevelMap ?? (known ? undefined : fromCatalog?.thinkingLevelMap);

	const make = (contextWindow: number): NativeModel => ({
		id,
		name: displayName(family, versionLabel),
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
		...(compat ? { compat } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	});

	// Curated families carry their pinned native window (opus/sonnet 1M, haiku
	// 200K) under their clean id — no `…-1m` alias. Unknown families use their
	// real catalog window.
	if (known) return [make(known.context === "single-1m" ? 1000000 : 200000)];
	return [make(fromCatalog?.contextWindow ?? 200000)];
}

function isCompleteModel(value: ModelOverride): value is NativeModel {
	const c = value.cost;
	return (
		typeof value.name === "string" &&
		typeof value.reasoning === "boolean" &&
		Array.isArray(value.input) &&
		!!c &&
		typeof c.input === "number" &&
		typeof c.output === "number" &&
		typeof c.cacheRead === "number" &&
		typeof c.cacheWrite === "number" &&
		typeof value.contextWindow === "number" &&
		typeof value.maxTokens === "number"
	);
}

/**
 * Build the native model list from the curated seed, optional runtime-discovered
 * ids, and optional user overrides.
 *
 * Precedence (highest wins): `overrides` > seed/curated overlay > discovered.
 * - Seed ids always use the curated family defaults (so the known models are
 *   byte-stable regardless of what Pi's catalog reports).
 * - Discovered (non-seed) ids inherit conservative family defaults and carry
 *   cost/maxTokens from `catalog` when provided.
 * - Overrides merge over a matching id, or append when the id is new and the
 *   entry is complete (incomplete new entries are skipped, never half-registered).
 */
export function buildNativeModels(opts?: {
	extraIds?: readonly string[];
	catalog?: Map<string, CatalogEntry>;
	overrides?: readonly ModelOverride[];
	allowlist?: RegExp;
}): NativeModel[] {
	const allow = opts?.allowlist ?? ALLOWLIST_RE;

	const ids: string[] = [];
	const seenIds = new Set<string>();
	for (const id of [...SEED_IDS, ...(opts?.extraIds ?? [])]) {
		if (seenIds.has(id) || !allow.test(id)) continue;
		seenIds.add(id);
		ids.push(id);
	}

	const out: NativeModel[] = [];
	const indexById = new Map<string, number>();
	for (const id of ids) {
		const fromCatalog = (SEED_IDS as readonly string[]).includes(id) ? undefined : opts?.catalog?.get(id);
		for (const model of buildFamilyModels(id, fromCatalog)) {
			if (indexById.has(model.id)) continue;
			indexById.set(model.id, out.length);
			out.push(model);
		}
	}

	for (const override of opts?.overrides ?? []) {
		if (!override || typeof override.id !== "string") continue;
		const existing = indexById.get(override.id);
		if (existing !== undefined) {
			out[existing] = { ...out[existing], ...override };
		} else if (isCompleteModel(override)) {
			indexById.set(override.id, out.length);
			out.push(override);
		}
	}

	return out;
}

/**
 * Default static list: the curated seed expanded with family defaults. Equal to
 * the hand-written list this module used to carry; runtime discovery and user
 * overrides are layered on at registration time in `index.ts`.
 */
export const NATIVE_MODELS: NativeModel[] = buildNativeModels();
