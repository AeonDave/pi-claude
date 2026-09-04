/**
 * On-disk state for the "Claude Pro/Max Native" provider: where it lives, how it
 * is read, validated and migrated.
 *
 * Split out of `constants.ts` because this is the impure half — every function
 * here touches the filesystem, and one of them MOVES the user's files. Isolating
 * it keeps `constants.ts` about values and resolution policy, and makes the
 * migration independently testable.
 *
 * Two locations matter:
 *   - `<agent dir>/claude-native/` — the current home, matching how every other
 *     Pi extension namespaces its state (`skill-optimizer/config.json`, …);
 *   - `~/.pi/claude-native-*.json` — the pre-1.5.0 loose files, still read, and
 *     moved onto the convention by `migrateLegacyState()`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { warnConfig } from "./warn.ts";

/**
 * Drop every memoized read so the next call hits the filesystem again.
 *
 * The reads below are cached because they run per model per registration. That
 * cache is process-lifetime by design, so anything that changes what is ON DISK
 * mid-process — a test pointing at a different home, or a fresh capture applied
 * while a session is running — must invalidate it explicitly.
 */
export function resetStateCaches(): void {
	fingerprintCache = undefined;
	installedVersionCache = undefined;
	migrated = false;
}

/** A dotted release version, e.g. `2.1.261`. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * A fingerprint captured from a real `claude` run by
 * `scripts/capture-fingerprint.mjs`. When present it overrides the hardcoded
 * defaults so the version and the `anthropic-beta` set stay a consistent,
 * freshly-captured pair. Path: `PI_CLAUDE_NATIVE_FINGERPRINT`, else
 * `<agent dir>/claude-native/fingerprint.json` (see `getStateDir`), with the
 * pre-1.5.0 `~/.pi/claude-native-fingerprint.json` still read as a fallback.
 */
export interface Fingerprint {
	version?: string;
	entrypoint?: string;
	anthropicBeta?: string;
	userAgent?: string;
	/**
	 * Per-model captured `anthropic-beta`, keyed by the WIRE model id, stored
	 * verbatim (so flag ORDER matches the genuine client, which differs per model
	 * — Haiku puts `claude-code-20250219` sixth, not first). Optional: an older
	 * fingerprint without it still resolves through the global set + the built-in
	 * deltas, and an older extension simply ignores the key.
	 */
	modelBeta?: Record<string, string>;
}

/** A hand-edited fingerprint must never crash the session — validate every field. */
export function coerceFingerprint(data: unknown): Fingerprint | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const raw = data as Record<string, unknown>;
	const str = (key: string): string | undefined => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
	const out: Fingerprint = {
		version: str("version"),
		entrypoint: str("entrypoint"),
		anthropicBeta: str("anthropicBeta"),
		userAgent: str("userAgent"),
	};
	const modelBeta = raw.modelBeta;
	if (modelBeta && typeof modelBeta === "object" && !Array.isArray(modelBeta)) {
		const map: Record<string, string> = {};
		for (const [id, value] of Object.entries(modelBeta as Record<string, unknown>)) {
			if (typeof value === "string" && value.length > 0) map[id] = value;
		}
		if (Object.keys(map).length > 0) out.modelBeta = map;
	}
	return out;
}

/**
 * Pi's own agent directory: `PI_CODING_AGENT_DIR` env, else `~/.pi/agent`.
 *
 * Resolved the same way Pi resolves it internally (`getAgentDir()`), but
 * REPLICATED rather than imported: this module deliberately imports nothing from
 * Pi at runtime, and the helper is not part of the extension API surface we can
 * rely on across Pi versions. Keep in sync if Pi ever moves its agent dir.
 */
export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/**
 * This extension's state directory — `<agent dir>/claude-native/`, matching how
 * every other Pi extension namespaces its state (e.g. `skill-optimizer/` holds
 * `config.json` / `profile.json` / `stats.json`). Before 1.5.0 this extension
 * dropped loose `claude-native-*.json` files directly into `~/.pi/`, which is not
 * where Pi keeps anything else; those legacy paths are still READ so an existing
 * install keeps working. Override with `PI_CLAUDE_NATIVE_STATE_DIR`.
 */
export function getStateDir(): string {
	return process.env.PI_CLAUDE_NATIVE_STATE_DIR?.trim() || join(getAgentDir(), "claude-native");
}

/** Pre-1.5.0 loose-file location. */
function legacyStatePath(file: string): string {
	return join(homedir(), ".pi", file);
}

/** Legacy file → its home under the state dir. */
const LEGACY_STATE_FILES: ReadonlyArray<[legacy: string, current: string]> = [
	["claude-native-fingerprint.json", "fingerprint.json"],
	["claude-native-models.json", "models.json"],
];

let migrated = false;

/**
 * Move pre-1.5.0 loose `~/.pi/claude-native-*.json` files into
 * `<agent dir>/claude-native/`, so an existing install ends up on the convention
 * instead of being read from the wrong place forever.
 *
 * Only moves when the destination does not already exist — a file at the current
 * path always wins, and nothing is ever overwritten. Entirely best-effort: a
 * read-only home, a permission error or a cross-device rename must never break
 * the session, and the read path falls back to the legacy location anyway.
 * Skipped when the user pinned an explicit path via env.
 */
export function migrateLegacyState(): void {
	if (migrated) return;
	migrated = true;
	if (process.env.PI_CLAUDE_NATIVE_FINGERPRINT?.trim() || process.env.PI_CLAUDE_NATIVE_MODELS_CACHE?.trim()) return;
	const dir = getStateDir();
	for (const [legacyName, currentName] of LEGACY_STATE_FILES) {
		const from = legacyStatePath(legacyName);
		const to = join(dir, currentName);
		try {
			if (!existsSync(from) || existsSync(to)) continue;
			mkdirSync(dir, { recursive: true });
			try {
				renameSync(from, to);
			} catch {
				// Different volume, or a lock: copy then drop the original.
				copyFileSync(from, to);
				unlinkSync(from);
			}
			warnConfig(`moved ${from} → ${to} (Pi's per-extension state convention)`);
		} catch {
			// Leave the legacy file alone; it is still read as a fallback.
		}
	}
}

/** Where the captured fingerprint is read from / written to. */
export function getFingerprintPath(): string {
	return process.env.PI_CLAUDE_NATIVE_FINGERPRINT?.trim() || join(getStateDir(), "fingerprint.json");
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

let fingerprintCache: Fingerprint | null | undefined;
export function readFingerprint(): Fingerprint | null {
	if (fingerprintCache !== undefined) return fingerprintCache;
	// An explicit env path is used alone — never silently fall back past a path the
	// user pointed us at, or a typo would look like "the fingerprint was ignored".
	const explicit = process.env.PI_CLAUDE_NATIVE_FINGERPRINT?.trim();
	const candidates = explicit
		? [explicit]
		: [getFingerprintPath(), legacyStatePath("claude-native-fingerprint.json")];
	for (const path of candidates) {
		try {
			fingerprintCache = coerceFingerprint(readJsonFile(path));
			if (fingerprintCache) return fingerprintCache;
		} catch {
			// absent/unreadable — try the next candidate
		}
	}
	fingerprintCache = null; // nothing readable — fall back to derivation/defaults
	return fingerprintCache;
}

/**
 * The version of the user's installed Claude Code, read from Claude's own state
 * files so the user-agent / billing `cc_version` track the real client with no
 * manual config. Tries the last-update record, then the seen-release-notes
 * marker. Returns `null` when neither is present.
 */
let installedVersionCache: string | null | undefined;
export function readInstalledClaudeVersion(): string | null {
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
 * Path to the persisted discovery cache (the "updated local seed" read at load
 * so the offline fallback stays fresh): `PI_CLAUDE_NATIVE_MODELS_CACHE` env, else
 * `<state dir>/models.json`.
 */
export function getModelCachePath(): string {
	return process.env.PI_CLAUDE_NATIVE_MODELS_CACHE?.trim() || join(getStateDir(), "models.json");
}

/**
 * Read order for the discovery cache: the current path, then the pre-1.5.0 loose
 * file. Writes always go to `getModelCachePath()`, so the legacy copy simply ages
 * out. An explicit env path is used alone.
 */
export function getModelCacheReadPaths(): string[] {
	const explicit = process.env.PI_CLAUDE_NATIVE_MODELS_CACHE?.trim();
	return explicit ? [explicit] : [getModelCachePath(), legacyStatePath("claude-native-models.json")];
}

