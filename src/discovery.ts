/**
 * Live model discovery (ON by default) + a persisted local fallback ("updated seed").
 *
 * The extension's default discovery reads Pi's *bundled* `anthropic` catalog
 * (`ctx.modelRegistry.getAll()`), which is a static generated file — so a
 * brand-new Claude (e.g. `claude-mythos-5`) only appears after the Pi package
 * ships an updated catalog. This module closes that gap:
 *
 *   1. `fetchLiveModels` queries Anthropic's own `GET /v1/models` with the
 *      subscription's OAuth token, so a model appears the day it ships;
 *   2. `writeModelCache`/`readModelCache` persist the result to
 *      `<agent dir>/claude-native/models.json`, which `index.ts` reads at load — so the
 *      offline/pre-session fallback stays as fresh as the last successful fetch.
 *
 * Everything is best-effort: any network/parse/fs error degrades silently to the
 * curated seed + Pi's catalog. `/v1/models` carries NO pricing, so discovered
 * entries deliberately omit `cost` — when Pi's catalog later lists the same id,
 * its real cost wins in the merge (see `index.ts`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CatalogEntry, parseModelId } from "./models.ts";

/** A discovered model: a clean id plus whatever the source could tell us (no cost). */
export interface DiscoveredModel {
	id: string;
	catalog: CatalogEntry;
}

/** One `capabilities.<x>` node: `{ supported: boolean }`, possibly with children. */
interface Supported {
	supported?: unknown;
}

/** Anthropic `/v1/models` item (only the fields we read; all optional/defensive). */
interface ModelInfo {
	id?: unknown;
	max_input_tokens?: unknown;
	max_tokens?: unknown;
	capabilities?: {
		thinking?: Supported & { types?: { enabled?: Supported; adaptive?: Supported } };
		effort?: Supported & { xhigh?: Supported; max?: Supported };
		image_input?: Supported;
	};
}

const isSupported = (node: Supported | undefined): boolean => node?.supported === true;

interface ModelCacheFile {
	version: number;
	fetchedAt: string;
	models: DiscoveredModel[];
}

const CACHE_VERSION = 1;
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Strip a trailing 8-digit date segment so a dated wire id becomes its clean
 * alias: `claude-sonnet-5-20260630` → `claude-sonnet-5`,
 * `claude-opus-4-1-20250805` → `claude-opus-4-1`. Non-dated ids are unchanged.
 */
export function stripDateSuffix(id: string): string {
	return id.replace(/-\d{8}$/, "");
}

/**
 * Map a `/v1/models` item to a `CatalogEntry` — never sets `cost` (the endpoint
 * carries no pricing, so Pi's catalog wins that field in the merge).
 *
 * Everything else this extension would otherwise hard-code per model IS here,
 * which is what lets a newly-shipped model work with no code change:
 *   - `capabilities.effort.xhigh/max`      → the effort ceiling (`thinkingLevelMap`)
 *   - `capabilities.thinking.types.*`      → adaptive vs budget, and adaptive-ONLY
 *   - `max_input_tokens` / `max_tokens`    → the real window and output cap
 *   - `capabilities.image_input`           → input modalities
 */
function modelInfoToCatalog(m: ModelInfo): CatalogEntry {
	const entry: CatalogEntry = {};
	const caps = m.capabilities;
	const adaptive = isSupported(caps?.thinking?.types?.adaptive);
	const budget = isSupported(caps?.thinking?.types?.enabled);

	// Only a source that explicitly reports the thinking TYPES can rule adaptive
	// out; an entry that simply omits them (an older cache, a partial response)
	// tells us nothing and must not trigger the clamp below.
	const knownNonAdaptive = !!caps?.thinking?.types && !adaptive;

	if (typeof m.max_input_tokens === "number" && m.max_input_tokens > 0) {
		// Guard: some older ids advertise a 1M window that is only unlocked by the
		// `context-1m-2025-08-07` beta, which this provider deliberately never sends
		// (a plan without long-context 400/429s on it). Adopting that number would
		// tell Pi it has 5x the room it really has, so it would never compact and the
		// request would die on a hard "prompt too long". Across Anthropic's 2026-09
		// catalog, native-1M and adaptive-thinking coincide exactly (opus 4.6+,
		// sonnet 4.6+, fable 5+ are both; sonnet 4.5 claims 1M but is budget-only and
		// needs the beta), so gate the >200K window on adaptive support. Erring low
		// only costs an early compaction; erring high is fatal. Pi's own catalog
		// wins this field anyway wherever it knows the id.
		entry.contextWindow = m.max_input_tokens > 200_000 && knownNonAdaptive ? 200_000 : m.max_input_tokens;
	}
	if (typeof m.max_tokens === "number" && m.max_tokens > 0) entry.maxTokens = m.max_tokens;
	if (typeof caps?.thinking?.supported === "boolean") entry.reasoning = caps.thinking.supported;
	if (caps?.thinking?.types) entry.forceAdaptiveThinking = adaptive;
	if (caps?.image_input) entry.input = isSupported(caps.image_input) ? ["text", "image"] : ["text"];

	// Effort ceiling. `xhigh` is the fact that used to require a hand-written
	// ID_OVERRIDES entry per model; the endpoint states it directly.
	if (typeof caps?.effort?.supported === "boolean") entry.supportsEffort = caps.effort.supported;
	if (isSupported(caps?.effort)) {
		const map: Record<string, string | null> = {};
		if (isSupported(caps?.effort?.xhigh)) map.xhigh = "xhigh";
		else if (isSupported(caps?.effort?.max)) map.xhigh = "max";
		if (isSupported(caps?.effort?.max)) map.max = "max";
		// Adaptive-ONLY models reject `thinking: {type: "disabled"}`. `off: null` is
		// how Pi is told not to send it (see its anthropic-messages path).
		if (adaptive && !budget) map.off = null;
		if (Object.keys(map).length > 0) entry.thinkingLevelMap = map as CatalogEntry["thinkingLevelMap"];
	}
	// Adaptive-only models also reject `temperature`.
	if (caps?.thinking?.types && adaptive && !budget) entry.supportsTemperature = false;

	return entry;
}

/**
 * Turn a raw `/v1/models` response into clean discovered models: strip date
 * suffixes, keep only ids that pass the same `parseModelId` gate as catalog
 * discovery (so legacy/`-latest`/dotted ids drop), and dedupe by id (later
 * entries merge per-field). Pure — safe to unit-test.
 */
export function normalizeModelsResponse(json: unknown): DiscoveredModel[] {
	const data = (json as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	const byId = new Map<string, CatalogEntry>();
	for (const raw of data) {
		const m = raw as ModelInfo | null;
		if (!m || typeof m.id !== "string") continue;
		const id = stripDateSuffix(m.id);
		// parseModelId subsumes the allowlist (it runs ALLOWLIST_RE internally) and
		// adds the semantic rule, so legacy/`-latest`/dotted ids drop here.
		if (parseModelId(id) === null) continue;
		byId.set(id, { ...byId.get(id), ...modelInfoToCatalog(m) });
	}
	return [...byId].map(([id, catalog]) => ({ id, catalog }));
}

/**
 * Query Anthropic's `GET /v1/models` with the subscription OAuth token. Returns
 * normalized discovered models, or `[]` on ANY failure (auth, network, parse) —
 * the caller always falls back to the cache + curated seed.
 */
export async function fetchLiveModels(opts: {
	token: string;
	endpoint: string;
	userAgent: string;
	timeoutMs?: number;
}): Promise<DiscoveredModel[]> {
	try {
		const res = await fetch(`${opts.endpoint}?limit=1000`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${opts.token}`,
				"anthropic-version": ANTHROPIC_VERSION,
				"anthropic-beta": "oauth-2025-04-20",
				"user-agent": opts.userAgent,
				"x-app": "cli",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
		});
		if (!res.ok) return [];
		return normalizeModelsResponse(await res.json());
	} catch {
		return [];
	}
}

/** Read the persisted discovery cache. Returns `[]` when absent/invalid. */
export function readModelCache(path: string): DiscoveredModel[] {
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as ModelCacheFile | null;
		if (!data || !Array.isArray(data.models)) return [];
		return data.models
			.filter((m): m is DiscoveredModel => !!m && typeof m.id === "string" && parseModelId(m.id) !== null)
			.map((m) => ({ id: m.id, catalog: m.catalog && typeof m.catalog === "object" ? m.catalog : {} }));
	} catch {
		return [];
	}
}

/** Persist the discovery cache (best-effort; swallows fs errors). */
export function writeModelCache(path: string, models: DiscoveredModel[]): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const payload: ModelCacheFile = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), models };
		writeFileSync(path, JSON.stringify(payload, null, 2));
	} catch {
		// best-effort — a stale/missing cache just means we fall back to the seed
	}
}
