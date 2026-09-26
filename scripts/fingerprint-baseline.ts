import { SERVER_CLASSIFIER_BETA } from "../src/fingerprint.ts";
import { parseModelId } from "../src/models.ts";

export interface FingerprintCandidate {
	wireModel: string;
	userAgent: string;
	version: string | null | undefined;
	entrypoint: string | null | undefined;
	effort: unknown;
	maxTokens: unknown;
	thinkingType?: unknown;
	budgetTokens?: unknown;
	hasCch?: boolean;
	identity?: unknown;
	thinkingDisplay?: unknown;
	toolsCount?: number;
	requestClass?: unknown;
	turnOrigin?: unknown;
	has1mBeta: boolean;
	/** The request body carried auto mode's server-classifier `safeguards` field. */
	hasSafeguards?: boolean;
	beta: string[];
	triggeredBy: string[];
}

export interface TuiThinkingProfile {
	type: string | null;
	display: string | null;
	budgetTokens: number | null;
	effort: string | null;
}

export interface TuiFingerprint {
	capturedAt: string;
	mode: "tui";
	version: string;
	entrypoint: "cli";
	userAgent: string;
	modelBeta: Record<string, string>;
	modelMaxTokens: Record<string, number>;
	modelThinking: Record<string, TuiThinkingProfile>;
}

export interface FingerprintBaseline {
	opus: FingerprintCandidate;
	sonnet: FingerprintCandidate;
	beta: string[];
}

export interface BetaDeviation {
	wireModel: string;
	adds: string[];
	drops: string[];
	reordered: boolean;
}

export interface CaptureRunSummary {
	model: string;
	captures: number;
	mainCaptures: number;
	wireModels?: readonly string[];
}

/**
 * Moving aliases discover the next flagship on rollover; exact ids retain full
 * coverage of every model currently exposed by the provider.
 */
export const DEFAULT_CAPTURE_MODELS = [
	"opus",
	"sonnet",
	"haiku",
	"fable",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-opus-4-5",
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
] as const;

/** Exact clean ids currently exposed by the provider; aliases are not enough for a TUI overlay. */
export const DEFAULT_TUI_CAPTURE_MODELS = DEFAULT_CAPTURE_MODELS.filter(
	(model): model is Extract<typeof DEFAULT_CAPTURE_MODELS[number], `claude-${string}`> => model.startsWith("claude-"),
);

const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/**
 * Spawn `claude` with auto mode's server-side classifier off. In auto mode it
 * otherwise adds `SERVER_CLASSIFIER_BETA` plus a `safeguards` body describing the
 * capturing user's permission rules, which Pi does not reproduce. Auto mode itself
 * (and its `afk-mode` flag) is unaffected.
 */
export const CAPTURE_CLAUDE_ENV = { CLAUDE_CODE_AUTO_MODE_SERVER: "0" } as const;

/** Environment for a captured `claude -p` run; the classifier switch is applied last. */
export function buildClaudeCaptureEnv(baseEnv: NodeJS.ProcessEnv, baseUrl: string): NodeJS.ProcessEnv {
	return {
		...baseEnv,
		ANTHROPIC_BASE_URL: baseUrl,
		// Claude Code omits cch when a custom base URL looks third-party. This
		// override makes a proxy capture retain the real first-party header.
		_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
		...CAPTURE_CLAUDE_ENV,
	};
}

/** The beta list plus the conditional wire signals every capture candidate records. */
export function captureWireFlags(
	body: unknown,
	betaHeader: unknown,
): { beta: string[]; has1mBeta: boolean; hasSafeguards: boolean } {
	const beta = typeof betaHeader === "string" ? betaHeader.split(",").map((flag) => flag.trim()).filter(Boolean) : [];
	return {
		beta,
		has1mBeta: beta.includes(CONTEXT_1M_BETA),
		hasSafeguards: !!body && typeof body === "object" && (body as { safeguards?: unknown }).safeguards !== undefined,
	};
}

function assertNoServerClassifier(candidate: FingerprintCandidate, kind: string): void {
	if (candidate.hasSafeguards === true || candidate.beta.includes(SERVER_CLASSIFIER_BETA)) {
		throw new Error(
			`${candidate.wireModel}: ${kind} capture carries auto mode's server classifier ` +
				`(safeguards / ${SERVER_CLASSIFIER_BETA}); recapture with CLAUDE_CODE_AUTO_MODE_SERVER=0 ` +
				`(capture:fingerprint already sets it; if the classifier persists, an "env" entry in Claude's ` +
				`settings overrides it — remove that entry for the capture run)`,
		);
	}
}

/** Read the current prompt from a hand-captured interactive turn with history. */
export function lastUserMessageText(body: unknown): string | undefined {
	if (!body || typeof body !== "object" || !Array.isArray((body as { messages?: unknown }).messages)) return undefined;
	const messages = (body as { messages: unknown[] }).messages;
	let message: Record<string, unknown> | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate && typeof candidate === "object" && (candidate as { role?: unknown }).role === "user") {
			message = candidate as Record<string, unknown>;
			break;
		}
	}
	if (!message) return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	for (let i = message.content.length - 1; i >= 0; i--) {
		const block = message.content[i];
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
			return (block as { text: string }).text;
		}
	}
	return undefined;
}

/** Select raw interactive turns by their probe only; profile drift must reach the strict validator. */
export function isRequestedTuiCapture(body: unknown, expectedPrompt: string): boolean {
	if (!body || typeof body !== "object") return false;
	const model = (body as { model?: unknown }).model;
	return typeof model === "string" && model.length > 0 && lastUserMessageText(body) === expectedPrompt;
}

/** Validate the private readiness proof returned by the just-spawned capture proxy. */
export function isCaptureProxyHealthResponse(
	statusCode: number | undefined,
	body: string,
	expectedNonce: string,
): boolean {
	if (statusCode !== 200 || expectedNonce.length === 0) return false;
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return false;
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const record = payload as Record<string, unknown>;
	return record.service === "pi-claude-capture-proxy" && record.nonce === expectedNonce;
}

/** Refuse to publish/apply a live run that missed any requested model. */
export function assertRequestedCapturesComplete(runs: readonly CaptureRunSummary[]): void {
	const missing = runs
		.filter((run) => !Number.isSafeInteger(run.mainCaptures) || run.mainCaptures <= 0)
		.map((run) => run.model);
	if (missing.length > 0) {
		throw new Error(`requested model run(s) produced no matching main capture: ${missing.join(", ")}`);
	}
}

function stripDateSuffix(modelId: string): string {
	return modelId.replace(/-\d{8}$/, "");
}

/** Reject clean/dated aliases that disagree on any distilled wire field. */
export function assertNoCanonicalModelDrift(candidates: readonly FingerprintCandidate[]): void {
	const canonical = new Map<string, FingerprintCandidate>();
	for (const candidate of candidates) {
		const key = stripDateSuffix(candidate.wireModel);
		const previous = canonical.get(key);
		if (previous) assertConsistentFingerprintCandidate(previous, candidate);
		else canonical.set(key, candidate);
	}
}

/** `capture:fingerprint` drives `claude -p`; reject hybrid/TUI request shapes. */
export function assertNonInteractiveCaptureProfile(
	candidates: readonly FingerprintCandidate[],
	expected: { entrypoint: string; identity: string; thinkingDisplay: string },
): void {
	for (const candidate of candidates) {
		if (candidate.entrypoint !== expected.entrypoint) {
			throw new Error(`${candidate.wireModel}: expected ${expected.entrypoint} non-interactive entrypoint`);
		}
		if (candidate.identity !== expected.identity) {
			throw new Error(`${candidate.wireModel}: non-interactive system identity mismatch`);
		}
		if (candidate.thinkingDisplay !== expected.thinkingDisplay) {
			throw new Error(`${candidate.wireModel}: non-interactive thinking.display mismatch`);
		}
	}
}

/** Validate hand-captured interactive Claude requests before producing a review artifact. */
export function selectTuiCaptureCandidates(
	candidates: readonly FingerprintCandidate[],
	expectedModels: readonly string[] = DEFAULT_TUI_CAPTURE_MODELS,
): FingerprintCandidate[] {
	const required = new Set(expectedModels.map(stripDateSuffix));
	const byModel = new Map<string, FingerprintCandidate>();
	let version: string | undefined;
	let userAgent: string | undefined;
	for (const candidate of candidates) {
		const model = stripDateSuffix(candidate.wireModel);
		if (!required.has(model) && !parseModelId(model)) {
			throw new Error(`unexpected TUI capture model: ${candidate.wireModel}`);
		}
		if (!candidate.version || !candidate.userAgent || candidate.entrypoint !== "cli") {
			throw new Error(`${candidate.wireModel}: expected cli interactive capture profile`);
		}
		if (!/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/.test(candidate.userAgent)) {
			throw new Error(`${candidate.wireModel}: expected external/cli user-agent`);
		}
		if (candidate.identity !== "You are Claude Code, Anthropic's official CLI for Claude.") {
			throw new Error(`${candidate.wireModel}: interactive Claude Code identity mismatch`);
		}
		if (candidate.thinkingDisplay !== "updates") {
			throw new Error(`${candidate.wireModel}: expected thinking.display=updates`);
		}
		if (candidate.requestClass !== "main") {
			throw new Error(`${candidate.wireModel}: expected x-claude-code-request-class=main`);
		}
		if (candidate.turnOrigin !== "human") {
			throw new Error(`${candidate.wireModel}: expected cc_turn_origin=human`);
		}
		if (candidate.toolsCount === undefined || !Number.isSafeInteger(candidate.toolsCount) || candidate.toolsCount <= 0) {
			throw new Error(`${candidate.wireModel}: main TUI capture must contain tools`);
		}
		if (candidate.hasCch !== true) throw new Error(`${candidate.wireModel}: first-party cch marker is missing`);
		if (candidate.beta.length === 0) throw new Error(`${candidate.wireModel}: anthropic-beta is empty`);
		if (new Set(candidate.beta).size !== candidate.beta.length) {
			throw new Error(`${candidate.wireModel}: anthropic-beta contains duplicate flags`);
		}
		if (candidate.has1mBeta || candidate.beta.includes(CONTEXT_1M_BETA)) {
			throw new Error(`${candidate.wireModel}: TUI capture unexpectedly contains ${CONTEXT_1M_BETA}`);
		}
		assertNoServerClassifier(candidate, "TUI");
		if (typeof candidate.maxTokens !== "number" || !Number.isSafeInteger(candidate.maxTokens) || candidate.maxTokens <= 0) {
			throw new Error(`${candidate.wireModel}: max_tokens must be a positive integer`);
		}
		if (candidate.effort !== null && candidate.effort !== undefined) {
			if (typeof candidate.effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(candidate.effort)) {
				throw new Error(`${candidate.wireModel}: output_config.effort is invalid`);
			}
		}
		if (candidate.thinkingType === "enabled" && (!Number.isSafeInteger(candidate.budgetTokens) || (candidate.budgetTokens as number) <= 0)) {
			throw new Error(`${candidate.wireModel}: thinking.budget_tokens must be a positive integer`);
		}
		if (version === undefined) version = candidate.version;
		else if (candidate.version !== version) throw new Error(`${candidate.wireModel}: TUI capture version differs from ${version}`);
		if (userAgent === undefined) userAgent = candidate.userAgent;
		else if (candidate.userAgent !== userAgent) throw new Error(`${candidate.wireModel}: TUI user-agent differs from the selected profile`);
		const previous = byModel.get(model);
		if (previous) assertConsistentFingerprintCandidate(previous, candidate);
		else byModel.set(model, candidate);
	}
	const missing = [...required].filter((model) => !byModel.has(model));
	if (missing.length > 0) throw new Error(`missing TUI capture(s): ${missing.join(", ")}`);
	const additional = [...byModel.keys()].filter((model) => !required.has(model)).sort((a, b) => a.localeCompare(b));
	return [...required, ...additional].map((model) => byModel.get(model)!);
}

/** Build a review-only TUI artifact. It is intentionally not the runtime fingerprint schema. */
export function buildTuiFingerprint(candidates: readonly FingerprintCandidate[], capturedAt: string): TuiFingerprint {
	if (candidates.length === 0 || !candidates[0].version || !candidates[0].userAgent) {
		throw new Error("cannot build TUI fingerprint without captured candidates");
	}
	const modelBeta: Record<string, string> = {};
	const modelMaxTokens: Record<string, number> = {};
	const modelThinking: Record<string, TuiThinkingProfile> = {};
	for (const candidate of candidates) {
		const model = stripDateSuffix(candidate.wireModel);
		modelBeta[model] = candidate.beta.join(",");
		modelMaxTokens[model] = candidate.maxTokens as number;
		modelThinking[model] = {
			type: typeof candidate.thinkingType === "string" ? candidate.thinkingType : null,
			display: typeof candidate.thinkingDisplay === "string" ? candidate.thinkingDisplay : null,
			budgetTokens: typeof candidate.budgetTokens === "number" ? candidate.budgetTokens : null,
			effort: typeof candidate.effort === "string" ? candidate.effort : null,
		};
	}
	return {
		capturedAt,
		mode: "tui",
		version: candidates[0].version,
		entrypoint: "cli",
		userAgent: candidates[0].userAgent,
		modelBeta,
		modelMaxTokens,
		modelThinking,
	};
}

/** Distinguish the requested normal turn from title/auxiliary traffic. */
export function isRequestedMainCapture(
	requestedModel: string,
	wireModel: string,
	firstUserText: string | undefined,
	expectedPrompt: string,
): boolean {
	if (firstUserText !== expectedPrompt) return false;
	const requested = stripDateSuffix(requestedModel);
	const wire = stripDateSuffix(wireModel);
	if (["opus", "sonnet", "haiku", "fable"].includes(requested)) {
		return wire.startsWith(`claude-${requested}-`);
	}
	if (requested.startsWith("claude-")) return wire === requested;
	// Claude supports additional moving aliases. Their resolved id is unknowable
	// here, but the exact probe text still separates the normal turn from helpers.
	return true;
}

/** Validate that UA and billing describe one real captured client profile. */
export function parseCaptureProfile(
	wireModel: string,
	userAgent: string,
	billingSystemText: string,
): { version: string; entrypoint: string } {
	const ua = userAgent.match(/^claude-cli\/(\d+\.\d+\.\d+) \(external, ([\w-]+)\)$/);
	const billing = billingSystemText.match(
		/cc_version=(\d+\.\d+\.\d+)\.[0-9a-f]{3}; cc_entrypoint=([\w-]+);/,
	);
	if (!ua || !billing) throw new Error(`${wireModel}: missing Claude Code user-agent or billing profile`);
	if (ua[1] !== billing[1]) {
		throw new Error(`${wireModel}: user-agent/billing version mismatch: ${ua[1]} vs ${billing[1]}`);
	}
	if (ua[2] !== billing[2]) {
		throw new Error(`${wireModel}: user-agent/billing entrypoint mismatch: ${ua[2]} vs ${billing[2]}`);
	}
	return { version: ua[1], entrypoint: ua[2] };
}

/** Repeated alias/exact captures of one wire id must agree on distilled fields. */
export function assertConsistentFingerprintCandidate(
	previous: FingerprintCandidate,
	current: FingerprintCandidate,
): void {
	const fields: ReadonlyArray<[string, unknown, unknown]> = [
		["user-agent", previous.userAgent, current.userAgent],
		["version", previous.version, current.version],
		["entrypoint", previous.entrypoint, current.entrypoint],
		["anthropic-beta", previous.beta.join(","), current.beta.join(",")],
		["max_tokens", previous.maxTokens, current.maxTokens],
		["effort", previous.effort, current.effort],
		["thinking.type", previous.thinkingType, current.thinkingType],
		["thinking.budget_tokens", previous.budgetTokens, current.budgetTokens],
		["system identity", previous.identity, current.identity],
		["thinking.display", previous.thinkingDisplay, current.thinkingDisplay],
		["request class", previous.requestClass, current.requestClass],
		["turn origin", previous.turnOrigin, current.turnOrigin],
	];
	for (const [field, before, after] of fields) {
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			throw new Error(`${current.wireModel}: repeated main captures disagree on ${field}`);
		}
	}
}

function generationFor(modelId: string, family: "opus" | "sonnet"): number[] | null {
	const prefix = `claude-${family}-`;
	const clean = stripDateSuffix(modelId);
	if (!clean.startsWith(prefix)) return null;
	const generation = clean.slice(prefix.length);
	if (!/^\d+(?:-\d+)*$/.test(generation)) return null;
	return generation.split("-").map(Number);
}

function compareGeneration(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const delta = (a[i] ?? 0) - (b[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function selectFamilyBaseline(
	candidates: readonly FingerprintCandidate[],
	family: "opus" | "sonnet",
): FingerprintCandidate {
	const label = family[0].toUpperCase() + family.slice(1);
	const familyCandidates = candidates.filter(
		(candidate) => generationFor(candidate.wireModel, family) !== null && Boolean(candidate.effort),
	);
	const aliasMatches = familyCandidates.filter((candidate) => candidate.triggeredBy.includes(family));
	if (aliasMatches.length > 1) {
		throw new Error(
			`ambiguous ${label} baseline: bare alias ${family} produced ${aliasMatches.map((candidate) => candidate.wireModel).join(", ")}`,
		);
	}
	if (aliasMatches.length === 1) return aliasMatches[0];

	// A comprehensive update capture commonly requests every full model id rather
	// than the bare aliases. Only consider captures whose owner is that exact wire
	// id (allowing a dated wire id for a clean requested id), then select the unique
	// newest generation. This excludes auxiliary/title-generation requests.
	const explicitMatches = familyCandidates.filter((candidate) =>
		candidate.triggeredBy.some((owner) => stripDateSuffix(owner) === stripDateSuffix(candidate.wireModel)),
	);
	// `--reuse` predates owners.json and explicitly promises recovery when that
	// sidecar is absent. In that case the wire ids are the only provenance left:
	// rank the ownerless family candidates by generation and keep the same
	// ambiguity checks below. If any exact owners exist, they remain preferred so
	// an auxiliary/title request cannot outrank a requested model.
	const selectable = explicitMatches.length > 0
		? explicitMatches
		: familyCandidates.filter((candidate) => candidate.triggeredBy.length === 0);
	if (selectable.length === 0) {
		throw new Error(`missing ${label} baseline: capture the bare ${family} alias or an explicit claude-${family}-<version> id`);
	}

	const ranked = selectable
		.map((candidate) => ({ candidate, generation: generationFor(candidate.wireModel, family) }))
		.filter((item): item is { candidate: FingerprintCandidate; generation: number[] } => item.generation !== null)
		.sort((a, b) => compareGeneration(b.generation, a.generation));
	const newest = ranked[0];
	const tied = ranked.filter((item) => compareGeneration(item.generation, newest.generation) === 0);
	if (tied.length > 1) {
		throw new Error(
			`ambiguous ${label} baseline: newest generation is represented by ${tied.map((item) => item.candidate.wireModel).join(", ")}`,
		);
	}
	return newest.candidate;
}

function assertUsableCapture(candidate: FingerprintCandidate): void {
	if (!candidate.version || !candidate.entrypoint || !candidate.userAgent) {
		throw new Error(`${candidate.wireModel}: missing version, entrypoint, or user-agent`);
	}
	if (candidate.beta.length === 0) throw new Error(`${candidate.wireModel}: anthropic-beta is empty`);
	if (candidate.hasCch !== true) throw new Error(`${candidate.wireModel}: first-party cch marker is missing`);
	if (new Set(candidate.beta).size !== candidate.beta.length) {
		throw new Error(`${candidate.wireModel}: anthropic-beta contains duplicate flags`);
	}
	if (candidate.has1mBeta || candidate.beta.includes(CONTEXT_1M_BETA)) {
		throw new Error(`${candidate.wireModel}: normal-turn capture unexpectedly contains ${CONTEXT_1M_BETA}`);
	}
	assertNoServerClassifier(candidate, "normal-turn");
}

export function selectFingerprintBaseline(candidates: readonly FingerprintCandidate[]): FingerprintBaseline {
	for (const candidate of candidates) assertUsableCapture(candidate);

	const opus = selectFamilyBaseline(candidates, "opus");
	const sonnet = selectFamilyBaseline(candidates, "sonnet");
	for (const [field, opusValue, sonnetValue] of [
		["version", opus.version, sonnet.version],
		["entrypoint", opus.entrypoint, sonnet.entrypoint],
		["user-agent", opus.userAgent, sonnet.userAgent],
	] as const) {
		if (opusValue !== sonnetValue) {
			throw new Error(`Opus/Sonnet baseline ${field} mismatch: opus=${opusValue} sonnet=${sonnetValue}`);
		}
	}

	// The global fallback must be safe for both current flagship families. Keep
	// Opus order, require Sonnet to order the shared flags identically, and record
	// every model's full string separately below. This prevents an Opus-only flag
	// from being promoted globally (the drift first observed in Claude 2.1.266).
	const sonnetSet = new Set(sonnet.beta);
	const opusSet = new Set(opus.beta);
	const beta = opus.beta.filter((flag) => sonnetSet.has(flag));
	const sonnetOrder = sonnet.beta.filter((flag) => opusSet.has(flag));
	if (beta.length === 0) throw new Error("Opus/Sonnet baseline intersection is empty");
	if (beta.join(",") !== sonnetOrder.join(",")) {
		throw new Error("Opus/Sonnet shared anthropic-beta flags have incompatible ordering");
	}

	// Mixing capture runs can silently pair one version with another version's
	// per-model beta values. Refuse that before producing or applying a file.
	for (const candidate of candidates) {
		if (
			candidate.version !== opus.version ||
			candidate.entrypoint !== opus.entrypoint ||
			candidate.userAgent !== opus.userAgent
		) {
			throw new Error(`${candidate.wireModel}: capture fingerprint differs from the selected Opus/Sonnet baseline`);
		}
	}

	return { opus, sonnet, beta };
}

export function buildModelBeta(candidates: readonly FingerprintCandidate[]): Record<string, string> {
	const modelBeta: Record<string, string> = {};
	for (const candidate of candidates) {
		if (candidate.beta.length > 0) modelBeta[candidate.wireModel] = candidate.beta.join(",");
	}
	return modelBeta;
}

/** Preserve each wire model's exact captured output ceiling, rejecting malformed raw captures. */
export function buildModelMaxTokens(candidates: readonly FingerprintCandidate[]): Record<string, number> {
	const modelMaxTokens: Record<string, number> = {};
	for (const candidate of candidates) {
		const maxTokens = candidate.maxTokens;
		if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
			throw new Error(`${candidate.wireModel}: max_tokens must be a positive integer`);
		}
		modelMaxTokens[candidate.wireModel] = maxTokens;
	}
	return modelMaxTokens;
}

/** Preserve exact legacy budget-thinking bodies for future no-code refreshes. */
export function buildModelBudgetThinking(
	candidates: readonly FingerprintCandidate[],
): Record<string, { budgetTokens: number; effort?: "low" | "medium" | "high" | "xhigh" | "max" }> {
	const result: Record<string, { budgetTokens: number; effort?: "low" | "medium" | "high" | "xhigh" | "max" }> = {};
	const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);
	for (const candidate of candidates) {
		if (candidate.thinkingType !== "enabled") continue;
		if (!Number.isSafeInteger(candidate.budgetTokens) || (candidate.budgetTokens as number) <= 0) {
			throw new Error(`${candidate.wireModel}: thinking.budget_tokens must be a positive integer`);
		}
		const profile: { budgetTokens: number; effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {
			budgetTokens: candidate.budgetTokens as number,
		};
		if (candidate.effort !== null && candidate.effort !== undefined) {
			if (typeof candidate.effort !== "string" || !efforts.has(candidate.effort)) {
				throw new Error(`${candidate.wireModel}: output_config.effort is invalid`);
			}
			profile.effort = candidate.effort as typeof profile.effort;
		}
		result[candidate.wireModel] = profile;
	}
	return result;
}

export function computeBetaDeviations(
	candidates: readonly FingerprintCandidate[],
	base: readonly string[],
): BetaDeviation[] {
	const baseSet = new Set(base);
	return candidates
		.map((candidate) => {
			const candidateSet = new Set(candidate.beta);
			return {
				wireModel: candidate.wireModel,
				adds: candidate.beta.filter((flag) => !baseSet.has(flag)),
				drops: base.filter((flag) => !candidateSet.has(flag)),
				reordered:
					candidate.beta.length === base.length &&
					candidate.beta.every((flag) => baseSet.has(flag)) &&
					candidate.beta.join(",") !== base.join(","),
			};
		})
		.filter((deviation) => deviation.adds.length > 0 || deviation.drops.length > 0 || deviation.reordered);
}
