/**
 * Rewrites the serialized Anthropic request payload to add Claude Code body
 * signals Pi's built-in OAuth path omits and remove the classifier trigger.
 *
 * When this runs (in `before_provider_request`), Pi has already produced, for an
 * OAuth token:
 *
 *   system = [ { "You are Claude Code, Anthropic's official CLI for Claude." },
 *              { <pi system prompt> } ]
 *
 * We turn it into the genuine mode-specific layout (the identity shown here is
 * the interactive form; print/json/rpc use the Claude Agent SDK sentence):
 *
 *   system = [ { x-anthropic-billing-header: ... },
 *              { "You are Claude Code..." },
 *              { <pi system prompt> } ]
 *
 * Pure and idempotent — no Pi imports — so it is unit-testable in isolation.
 */

import { type BillingMessage, buildBillingHeaderValue } from "./billing-header.ts";

const BILLING_PREFIX = "x-anthropic-billing-header:";
const KNOWN_CLAUDE_IDENTITIES = new Set([
	"You are Claude Code, Anthropic's official CLI for Claude.",
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);

interface SystemTextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
}

interface AnthropicPayload {
	system?: unknown;
	messages?: unknown;
	thinking?: unknown;
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
export function applyBillingHeader(payload: unknown, version: string, entrypoint: string, sessionId?: string): unknown {
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
		text: buildBillingHeaderValue(messages, version, entrypoint, sessionId),
	};

	return { ...typed, system: [headerBlock, ...blocks] };
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

/**
 * Clamp `max_tokens` to the cap observed on genuine Claude Code for this model.
 * Pi's catalog describes the API's larger absolute ceiling, so without this
 * request-only transform Pi emits 128K/64K where the bundled CLI capture emits
 * 64K/32K. A deliberately smaller caller value is preserved. Pure/idempotent.
 */
export function applyClaudeCodeMaxTokens(payload: unknown, capturedCap: number | undefined): unknown {
	if (!payload || typeof payload !== "object") return payload;
	if (capturedCap === undefined || !Number.isSafeInteger(capturedCap) || capturedCap <= 0) return payload;
	const typed = payload as AnthropicPayload;
	// Never clamp below a budget the caller already committed to: Anthropic requires
	// `budget_tokens < max_tokens`, and Pi sizes the budget against ITS max_tokens
	// (`min(budget, max_tokens - 1024)`) before we ever see the payload. Lowering the
	// cap underneath a large user-chosen budget therefore turns a working request into
	// a hard 400. Genuine Claude Code never emits that pair either, so leaving the
	// payload untouched is both the safe and the faithful answer.
	const thinking = typed.thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
	if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= capturedCap) {
		return payload;
	}
	const current = typed.max_tokens;
	if (typeof current === "number" && current > 0 && current <= capturedCap) return payload;
	return { ...typed, max_tokens: capturedCap };
}

/**
 * Align Pi's built-in Claude identity with the genuine profile for this mode.
 * Only the two exact first-party identities are replaceable; arbitrary system
 * text is never rewritten. Pure and idempotent.
 */
export function applyClaudeCodeIdentity(payload: unknown, identity: string): unknown {
	if (!payload || typeof payload !== "object" || !KNOWN_CLAUDE_IDENTITIES.has(identity)) return payload;
	const typed = payload as AnthropicPayload;
	const blocks = toSystemBlocks(typed.system);
	let changed = false;
	const next = blocks.map((block) => {
		if (!isSystemTextBlock(block) || !KNOWN_CLAUDE_IDENTITIES.has(block.text) || block.text === identity) return block;
		changed = true;
		return { ...block, text: identity };
	});
	return changed ? { ...typed, system: next } : payload;
}

/**
 * Align the `context_management` body field that the captured Claude Code profile
 * sends alongside the `context-management-2025-06-27` beta flag. Enabled or
 * adaptive thinking gets the clear-thinking edit; disabled or omitted thinking
 * must not carry it. Existing unrelated edits are preserved. Pure and
 * idempotent: returns the original reference when no edit is needed.
 */
export function applyContextManagement(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const typed = payload as AnthropicPayload;
	const thinking = typed.thinking;
	const thinkingType = thinking && typeof thinking === "object"
		? (thinking as { type?: unknown }).type
		: undefined;
	const thinkingEnabled = thinkingType === "adaptive" || thinkingType === "enabled";

	// `clear_thinking_20251015` is rejected when thinking is disabled (or when
	// Pi omitted the field for `--thinking off`). Do not add it to such requests,
	// and remove only that incompatible edit if an earlier transform supplied it.
	if (!thinkingEnabled) {
		const contextManagement = typed.context_management;
		if (!contextManagement || typeof contextManagement !== "object") return payload;
		const edits = (contextManagement as { edits?: unknown }).edits;
		if (!Array.isArray(edits)) return payload;
		const compatibleEdits = edits.filter((edit) =>
			!edit || typeof edit !== "object" || (edit as { type?: unknown }).type !== "clear_thinking_20251015",
		);
		if (compatibleEdits.length === edits.length) return payload;
		return {
			...typed,
			context_management: { ...(contextManagement as Record<string, unknown>), edits: compatibleEdits },
		};
	}

	const clearThinkingEdit = { type: "clear_thinking_20251015", keep: "all" };
	if (typed.context_management !== undefined) {
		const contextManagement = typed.context_management;
		if (!contextManagement || typeof contextManagement !== "object") return payload;
		const edits = (contextManagement as { edits?: unknown }).edits;
		if (edits === undefined) {
			return {
				...typed,
				context_management: { ...(contextManagement as Record<string, unknown>), edits: [clearThinkingEdit] },
			};
		}
		if (!Array.isArray(edits)) return payload;
		if (edits.some((edit) => edit && typeof edit === "object" && (edit as { type?: unknown }).type === clearThinkingEdit.type)) {
			return payload;
		}
		return {
			...typed,
			context_management: { ...(contextManagement as Record<string, unknown>), edits: [...edits, clearThinkingEdit] },
		};
	}
	return {
		...typed,
		context_management: { edits: [clearThinkingEdit] },
	};
}

/**
 * Inject the `diagnostics` body field that the captured Claude Code profile sends.
 * On the first turn `previous_message_id` is `null`; tracking across turns is
 * outside our scope (the API accepts `null` gracefully). Idempotent.
 */
export function applyDiagnostics(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const typed = payload as AnthropicPayload;
	if (typed.diagnostics !== undefined) return payload;
	return { ...typed, diagnostics: { previous_message_id: null } };
}

/**
 * Claude Code uses `display: "updates"` interactively and `display: "omitted"`
 * in `-p`/SDK mode for both adaptive and budget thinking. Pi's Anthropic path
 * defaults to `summarized`; align it after serialization without affecting
 * disabled thinking. Pure and idempotent.
 */
export function applyClaudeCodeThinkingDisplay(payload: unknown, display: "updates" | "omitted" = "omitted"): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const typed = payload as AnthropicPayload;
	const thinking = typed.thinking;
	if (!thinking || typeof thinking !== "object") return payload;
	const type = (thinking as { type?: unknown }).type;
	if (type !== "adaptive" && type !== "enabled") {
		return payload;
	}
	if ((thinking as { display?: unknown }).display === display) return payload;
	return { ...typed, thinking: { ...thinking, display } };
}

export interface BudgetThinkingProfile {
	budgetTokens: number;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Align the exact budget-thinking shape captured for older Claude models. */
export function applyClaudeCodeBudgetThinkingProfile(
	payload: unknown,
	profile: BudgetThinkingProfile | undefined,
): unknown {
	if (!payload || typeof payload !== "object" || !profile) return payload;
	if (!Number.isSafeInteger(profile.budgetTokens) || profile.budgetTokens <= 0) return payload;
	const typed = payload as AnthropicPayload;
	const thinking = typed.thinking;
	if (!thinking || typeof thinking !== "object" || (thinking as { type?: unknown }).type !== "enabled") return payload;
	const currentBudget = (thinking as { budget_tokens?: unknown }).budget_tokens;
	// The real capture corresponds to Pi's `high` budget (16,384 before this
	// alignment). Preserve explicit minimal/low/medium choices instead of silently
	// escalating the user's reasoning budget.
	if (currentBudget !== 16_384 && currentBudget !== profile.budgetTokens) return payload;
	// A caller may deliberately request a smaller response. Never raise the
	// thinking budget above that request's max_tokens (Anthropic rejects it).
	if (typeof typed.max_tokens === "number" && typed.max_tokens <= profile.budgetTokens) return payload;

	let changed = currentBudget !== profile.budgetTokens;
	const nextThinking = changed ? { ...thinking, budget_tokens: profile.budgetTokens } : thinking;
	let nextOutput = typed.output_config;
	if (profile.effort) {
		const output = typed.output_config && typeof typed.output_config === "object"
			? typed.output_config as Record<string, unknown>
			: {};
		if (output.effort !== profile.effort) {
			nextOutput = { ...output, effort: profile.effort };
			changed = true;
		}
	}
	return changed ? { ...typed, thinking: nextThinking, ...(profile.effort ? { output_config: nextOutput } : {}) } : payload;
}
