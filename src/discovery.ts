/**
 * Optional live model discovery + a persisted local fallback ("updated seed").
 *
 * The extension's default discovery reads Pi's *bundled* `anthropic` catalog
 * (`ctx.modelRegistry.getAll()`), which is a static generated file — so a
 * brand-new Claude (e.g. `claude-mythos-5`) only appears after the Pi package
 * ships an updated catalog. This module closes that gap, opt-in:
 *
 *   1. `fetchLiveModels` queries Anthropic's own `GET /v1/models` with the
 *      subscription's OAuth token, so a model appears the day it ships;
 *   2. `writeModelCache`/`readModelCache` persist the result to
 *      `~/.pi/claude-native-models.json`, which `index.ts` reads at load — so the
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

/** Anthropic `/v1/models` item (only the fields we read; all optional/defensive). */
interface ModelInfo {
	id?: unknown;
	max_input_tokens?: unknown;
	max_tokens?: unknown;
	capabilities?: { thinking?: { supported?: unknown } };
}

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

/** Map a `/v1/models` item to a `CatalogEntry` — never sets `cost` (not provided). */
function modelInfoToCatalog(m: ModelInfo): CatalogEntry {
	const entry: CatalogEntry = {};
	if (typeof m.max_input_tokens === "number" && m.max_input_tokens > 0) entry.contextWindow = m.max_input_tokens;
	if (typeof m.max_tokens === "number" && m.max_tokens > 0) entry.maxTokens = m.max_tokens;
	const thinking = m.capabilities?.thinking?.supported;
	if (typeof thinking === "boolean") entry.reasoning = thinking;
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
