/**
 * Rewrites the serialized Anthropic request payload to add the one piece Pi's
 * built-in OAuth path is missing: Claude Code's `x-anthropic-billing-header`.
 *
 * When this runs (in `before_provider_request`), Pi has already produced, for an
 * OAuth token:
 *
 *   system = [ { "You are Claude Code, Anthropic's official CLI for Claude." },
 *              { <pi system prompt> } ]
 *
 * We turn it into the genuine Claude Code layout:
 *
 *   system = [ { x-anthropic-billing-header: ... },
 *              { "You are Claude Code..." },
 *              { <pi system prompt> } ]
 *
 * Pure and idempotent — no Pi imports — so it is unit-testable in isolation.
 */

import { type BillingMessage, buildBillingHeaderValue } from "./billing-header.ts";

const BILLING_PREFIX = "x-anthropic-billing-header:";

interface SystemTextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
}

interface AnthropicPayload {
	system?: unknown;
	messages?: unknown;
	[key: string]: unknown;
}

function isSystemTextBlock(value: unknown): value is SystemTextBlock {
	return (
		!!value &&
		typeof value === "object" &&
		(value as SystemTextBlock).type === "text" &&
		typeof (value as SystemTextBlock).text === "string"
	);
}

/** Normalize Anthropic's `system` field (string | block | array) to a block array. */
function toSystemBlocks(system: unknown): unknown[] {
	if (Array.isArray(system)) return system;
	if (isSystemTextBlock(system)) return [system];
	if (typeof system === "string" && system.length > 0) {
		return [{ type: "text", text: system } satisfies SystemTextBlock];
	}
	return [];
}

/**
 * Returns the payload with the billing header prepended as `system[0]`.
 *
 * Returns the original reference unchanged when there is nothing to do (no user
 * message to fingerprint, or the header is already present), so callers can
 * cheaply detect "no change" by identity.
 */
export function applyBillingHeader(payload: unknown, version: string, entrypoint: string): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const typed = payload as AnthropicPayload;

	const messages = Array.isArray(typed.messages) ? (typed.messages as BillingMessage[]) : [];
	// The cch hashes the first user message; with no user message there is
	// nothing to fingerprint, exactly like Claude Code.
	if (!messages.some((message) => message?.role === "user")) return payload;

	const blocks = toSystemBlocks(typed.system);
	if (blocks.some((block) => isSystemTextBlock(block) && block.text.startsWith(BILLING_PREFIX))) {
		return payload; // already injected — keep idempotent
	}

	const headerBlock: SystemTextBlock = {
		type: "text",
		text: buildBillingHeaderValue(messages, version, entrypoint),
	};

	return { ...typed, system: [headerBlock, ...blocks] };
}

/**
 * Set the wire model id (e.g. `claude-opus-4-8[1m]`) on the payload. Genuine
 * Claude Code uses the `[1m]` suffix to request the 1M context window; Pi-facing
 * model ids stay clean and the suffix is applied here. Returns the original
 * reference when already set, so callers can detect "no change" by identity.
 */
export function setWireModel(payload: unknown, wireModelId: string): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const typed = payload as { model?: unknown };
	if (typed.model === wireModelId) return payload;
	return { ...typed, model: wireModelId };
}

/** A literal find/replace applied to system-prompt text. */
export interface SystemReplacement {
	match: string;
	replacement: string;
}

/** How to scrub the system prompt of third-party-agent-harness fingerprints. */
export interface SanitizeRules {
	/** Drop any blank-line-separated paragraph that contains one of these anchors. */
	removeAnchors?: readonly string[];
	/** Literal find/replace applied after paragraph removal. */
	replacements?: readonly SystemReplacement[];
}

function sanitizeText(text: string, rules: SanitizeRules): string {
	let result = text;
	const anchors = rules.removeAnchors ?? [];
	if (anchors.length > 0 && anchors.some((anchor) => result.includes(anchor))) {
		// Paragraphs are separated by one or more blank lines, like Claude Code's
		// and opencode's prompts. Drop whole paragraphs that contain an anchor.
		result = result
			.split(/\n\n+/)
			.filter((paragraph) => !anchors.some((anchor) => paragraph.includes(anchor)))
			.join("\n\n");
	}
	for (const { match, replacement } of rules.replacements ?? []) {
		if (match.length > 0 && result.includes(match)) result = result.split(match).join(replacement);
	}
	return result;
}

/**
 * Scrub every system text block (except the billing-header block) of
 * third-party-agent-harness fingerprints that Anthropic's backend rejects (a 400
 * disguised as a usage error). Removes anchored paragraphs (Pi's meta-development
 * "Pi documentation" section, which the classifier flags) and applies literal
 * replacements. Returns the original reference when nothing changed, so callers
 * can detect "no change" by identity. Pure and idempotent.
 *
 * Scope note: this is the edit the Claude path *needs* to function. General
 * token trimming (e.g. stripping the `<available_skills>` catalog) lives in the
 * separate `pi-skill-optimizer` extension, not here.
 */
export function sanitizeSystemPrompt(payload: unknown, rules: SanitizeRules): unknown {
	if (!payload || typeof payload !== "object") return payload;
	if (!rules.removeAnchors?.length && !rules.replacements?.length) return payload;
	const typed = payload as AnthropicPayload;
	const blocks = toSystemBlocks(typed.system);
	if (blocks.length === 0) return payload;

	let changed = false;
	const next = blocks.map((block) => {
		if (!isSystemTextBlock(block) || block.text.startsWith(BILLING_PREFIX)) return block;
		const text = sanitizeText(block.text, rules);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? { ...typed, system: next } : payload;
}

/**
 * Set `metadata.user_id` to the genuine Claude Code value (a JSON string with
 * device/account/session ids), which Pi's path omits. Skips when no id is given
 * or one is already present. Returns the original reference on no change.
 */
export function applyMetadata(payload: unknown, userId: string | undefined): unknown {
	if (!payload || typeof payload !== "object" || !userId) return payload;
	const typed = payload as AnthropicPayload & { metadata?: { user_id?: unknown } };
	if (typed.metadata && typeof typed.metadata === "object" && "user_id" in typed.metadata) return payload;
	return { ...typed, metadata: { ...(typed.metadata ?? {}), user_id: userId } };
}
